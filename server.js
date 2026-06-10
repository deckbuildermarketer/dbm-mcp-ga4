import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const CLIENTS = JSON.parse(fs.readFileSync("./client_registry.json", "utf8"));

function getGoogleCredentials() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable");
  }

  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

const analyticsDataClient = new BetaAnalyticsDataClient({
  credentials: getGoogleCredentials()
});

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!process.env.MCP_API_KEY) {
    return res.status(500).json({
      error: "Server missing MCP_API_KEY"
    });
  }

  if (authHeader !== `Bearer ${process.env.MCP_API_KEY}`) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

function resolveDateRange(period = "last_30_days") {
  switch (period) {
    case "today":
      return { startDate: "today", endDate: "today" };

    case "yesterday":
      return { startDate: "yesterday", endDate: "yesterday" };

    case "last_7_days":
      return { startDate: "7daysAgo", endDate: "yesterday" };

    case "last_30_days":
      return { startDate: "30daysAgo", endDate: "yesterday" };

    case "this_month":
      return { startDate: "firstDayOfMonth", endDate: "today" };

    case "last_month":
      return { startDate: "firstDayOfLastMonth", endDate: "lastDayOfLastMonth" };

    default:
      return { startDate: "30daysAgo", endDate: "yesterday" };
  }
}

function getReportConfig(report_type = "summary") {
  switch (report_type) {
    case "top_pages":
      return {
        dimensions: ["pagePath"],
        metrics: ["screenPageViews", "sessions", "activeUsers", "conversions"],
        limit: 10,
        orderBys: [
          {
            metric: {
              metricName: "screenPageViews"
            },
            desc: true
          }
        ]
      };

    case "channels":
      return {
        dimensions: ["sessionDefaultChannelGroup"],
        metrics: ["sessions", "activeUsers", "conversions", "engagementRate"],
        limit: 10,
        orderBys: [
          {
            metric: {
              metricName: "sessions"
            },
            desc: true
          }
        ]
      };

    case "daily":
      return {
        dimensions: ["date"],
        metrics: ["sessions", "activeUsers", "screenPageViews", "conversions"],
        limit: 100,
        orderBys: [
          {
            dimension: {
              dimensionName: "date"
            }
          }
        ]
      };

    case "events":
      return {
        dimensions: ["eventName"],
        metrics: ["eventCount", "activeUsers"],
        limit: 20,
        orderBys: [
          {
            metric: {
              metricName: "eventCount"
            },
            desc: true
          }
        ]
      };

    case "summary":
    default:
      return {
        dimensions: [],
        metrics: [
          "sessions",
          "activeUsers",
          "newUsers",
          "screenPageViews",
          "conversions",
          "engagementRate",
          "averageSessionDuration"
        ],
        limit: 10,
        orderBys: []
      };
  }
}

function formatRows(response, dimensions, metrics) {
  return (response.rows || []).map((row) => {
    const item = {};

    dimensions.forEach((dimension, index) => {
      item[dimension] = row.dimensionValues[index]?.value ?? null;
    });

    metrics.forEach((metric, index) => {
      const rawValue = row.metricValues[index]?.value ?? null;
      const numberValue = rawValue !== null && !Number.isNaN(Number(rawValue))
        ? Number(rawValue)
        : rawValue;

      item[metric] = numberValue;
    });

    return item;
  });
}

async function getGA4Metrics(args) {
  const {
    client_code,
    period = "last_30_days",
    report_type = "summary"
  } = args || {};

  if (!client_code) {
    throw new Error("client_code is required");
  }

  const client = CLIENTS[client_code];

  if (!client) {
    throw new Error(`Unknown client_code: ${client_code}`);
  }

  const dateRange = resolveDateRange(period);
  const config = getReportConfig(report_type);

  const [response] = await analyticsDataClient.runReport({
    property: `properties/${client.ga4_property_id}`,
    dateRanges: [
      {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate
      }
    ],
    dimensions: config.dimensions.map((name) => ({ name })),
    metrics: config.metrics.map((name) => ({ name })),
    orderBys: config.orderBys,
    limit: config.limit
  });

  const rows = formatRows(response, config.dimensions, config.metrics);

  return {
    success: true,
    source: "GA4",
    client_code,
    client_name: client.client_name,
    ga4_property_id: client.ga4_property_id,
    period,
    date_range: dateRange,
    report_type,
    rows,
    row_count: rows.length,
    note: "Live data pulled from Google Analytics 4 via Google Analytics Data API."
  };
}

async function getGA4Realtime(args) {
  const { client_code } = args || {};

  if (!client_code) {
    throw new Error("client_code is required");
  }

  const client = CLIENTS[client_code];

  if (!client) {
    throw new Error(`Unknown client_code: ${client_code}`);
  }

  const [response] = await analyticsDataClient.runRealtimeReport({
    property: `properties/${client.ga4_property_id}`,
    dimensions: [
      { name: "country" },
      { name: "deviceCategory" }
    ],
    metrics: [
      { name: "activeUsers" }
    ]
  });

  const rows = formatRows(response, ["country", "deviceCategory"], ["activeUsers"]);

  return {
    success: true,
    source: "GA4 Realtime",
    client_code,
    client_name: client.client_name,
    ga4_property_id: client.ga4_property_id,
    report_type: "realtime",
    rows,
    row_count: rows.length,
    note: "Live realtime data pulled from Google Analytics 4."
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    name: "DBM GA4 MCP Server",
    mcp_endpoint: "/mcp"
  });
});

app.post("/mcp", requireAuth, async (req, res) => {
  const { jsonrpc = "2.0", id = null, method, params } = req.body || {};
  if (method === "notifications/initialized") {
    return res.status(202).end();
  }
  try {
    if (method === "initialize") {
      return res.json({
        jsonrpc,
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "DBM-ga4-mcp",
            version: "1.0.0"
          }
        }
      });
    }

    if (method === "tools/list") {
      return res.json({
        jsonrpc,
        id,
        result: {
          tools: [
            {
              name: "get_ga4_metrics",
              description:
                "Get live Google Analytics 4 metrics for a client. Use this for traffic, sessions, users, conversions, engagement, channels, top pages, events, and website performance questions.",
              inputSchema: {
                type: "object",
                properties: {
                  client_code: {
                    type: "string",
                    description: "Internal client code. Example: deckdogs."
                  },
                  period: {
                    type: "string",
                    enum: [
                      "today",
                      "yesterday",
                      "last_7_days",
                      "last_30_days",
                      "this_month",
                      "last_month"
                    ],
                    description: "Date range to query. Default: last_30_days."
                  },
                  report_type: {
                    type: "string",
                    enum: [
                      "summary",
                      "top_pages",
                      "channels",
                      "daily",
                      "events"
                    ],
                    description: "GA4 report type. Default: summary."
                  }
                },
                required: ["client_code"]
              }
            },
            {
              name: "get_ga4_realtime",
              description:
                "Get realtime GA4 active user data for a client. Use this when the user asks about live users, real-time traffic, or what is happening on the site right now.",
              inputSchema: {
                type: "object",
                properties: {
                  client_code: {
                    type: "string",
                    description: "Internal client code. Example: deckdogs."
                  }
                },
                required: ["client_code"]
              }
            }
          ]
        }
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      let result;

      if (toolName === "get_ga4_metrics") {
        result = await getGA4Metrics(toolArgs);
      } else if (toolName === "get_ga4_realtime") {
        result = await getGA4Realtime(toolArgs);
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      return res.json({
        jsonrpc,
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result)
            }
          ]
        }
      });
    }

    return res.status(400).json({
      jsonrpc,
      id,
      error: {
        code: -32601,
        message: `Unsupported method: ${method}`
      }
    });
  } catch (error) {
    return res.status(500).json({
      jsonrpc,
      id,
      error: {
        code: -32000,
        message: error.message
      }
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`DBM GA4 MCP server running on port ${port}`);
});