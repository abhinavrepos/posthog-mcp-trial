var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/rasterizer-entry.ts
var rasterizer_entry_exports = {};
__export(rasterizer_entry_exports, {
  BrowserPool: () => BrowserPool,
  rasterizeFile: () => rasterizeFile
});
module.exports = __toCommonJS(rasterizer_entry_exports);

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/browser-pool.ts
var import_puppeteer_capture = require("puppeteer-capture");

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/config.ts
function parseList(text) {
  if (!text) {
    return [];
  }
  return text.split(",").map((item) => item.trim());
}
function parsePositiveInt(raw, fallback) {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function parseFraction(raw, fallback) {
  const n = parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}
var config = {
  // Temporal
  temporalHost: process.env.TEMPORAL_HOST || "127.0.0.1",
  temporalPort: process.env.TEMPORAL_PORT || "7233",
  temporalNamespace: process.env.TEMPORAL_NAMESPACE || "default",
  taskQueue: process.env.TEMPORAL_TASK_QUEUE || "rasterization-task-queue",
  temporalClientRootCA: process.env.TEMPORAL_CLIENT_ROOT_CA,
  temporalClientCert: process.env.TEMPORAL_CLIENT_CERT,
  temporalClientKey: process.env.TEMPORAL_CLIENT_KEY,
  // Worker
  logLevel: process.env.LOG_LEVEL || "info",
  maxConcurrentActivities: parsePositiveInt(process.env.MAX_CONCURRENT_ACTIVITIES, 4),
  // Above these fractions of the cgroup limit, the worker takes no activity beyond its first slot.
  tunerTargetMemoryUsage: parseFraction(process.env.TUNER_TARGET_MEMORY_USAGE, 0.7),
  tunerTargetCpuUsage: parseFraction(process.env.TUNER_TARGET_CPU_USAGE, 0.9),
  tunerRampThrottleMs: parsePositiveInt(process.env.TUNER_RAMP_THROTTLE_MS, 1e4),
  browserRecycleAfter: parsePositiveInt(process.env.BROWSER_RECYCLE_AFTER, 100),
  // Browsers held warm beyond this are closed on release: each idle Chromium pins 100-250MB RSS,
  // and a pod that once ran at full concurrency would otherwise keep that footprint forever.
  maxIdleBrowsers: parsePositiveInt(process.env.MAX_IDLE_BROWSERS, 2),
  disableBrowserSecurity: process.env.DISABLE_BROWSER_SECURITY === "1",
  captureBrowserLogs: process.env.CAPTURE_BROWSER_LOGS === "1",
  screenshotFormat: process.env.SCREENSHOT_FORMAT || "jpeg",
  // Hard cap on a single beginFrame; mass-image-decode stalls legitimately run 30-60s, so keep
  // this well above that. It only exists to bound a truly wedged compositor.
  beginFrameTimeoutMs: parsePositiveInt(process.env.BEGINFRAME_TIMEOUT_MS, 12e4),
  screenshotJpegQuality: parsePositiveInt(process.env.SCREENSHOT_JPEG_QUALITY, 80),
  metricsPort: parsePositiveInt(process.env.METRICS_PORT, 6738),
  // Encryption
  secretKey: process.env.TEMPORAL_SECRET_KEY || process.env.SECRET_KEY,
  fallbackKeys: parseList(process.env.TEMPORAL_FALLBACK_SECRET_KEYS ?? process.env.SECRET_KEY).filter(Boolean),
  // S3
  s3Endpoint: process.env.VIDEO_EXPORT_OBJECT_STORAGE_ENDPOINT,
  s3Region: process.env.VIDEO_EXPORT_OBJECT_STORAGE_REGION || "us-east-1",
  // `s3://bucket/prefix/` entries a render's source_s3_uri may point into. Empty disables file sources.
  sourceS3Prefixes: parseList(process.env.RASTERIZER_SOURCE_S3_PREFIXES ?? "").filter(Boolean),
  // Bounds a zstd source's decompressed size, which its compressed size under the gate above does not. The
  // body reaches the page as base64 text, so it has to stay well under V8's string limit.
  maxSourceDecompressedBytes: parsePositiveInt(process.env.MAX_SOURCE_DECOMPRESSED_BYTES, 256 * 1024 * 1024),
  // Recording API. The dev recording-api listens on 6741 (bin/temporal-recording-rasterizer-worker).
  recordingApiBaseUrl: process.env.RECORDING_API_BASE_URL || "http://localhost:6741",
  recordingApiSecret: process.env.INTERNAL_API_SECRET || "",
  // The listing hits ClickHouse through recording-api, so internalFetch's 3s default aborts it under load.
  blockListingTimeoutMs: parsePositiveInt(process.env.BLOCK_LISTING_TIMEOUT_MS, 3e4),
  // Renders above this many compressed bytes fail permanently instead of loading the pod into its
  // memory limit. Deliberately generous: the every-render byte log is what tightens it over time.
  maxRecordingCompressedBytes: parsePositiveInt(process.env.MAX_RECORDING_COMPRESSED_BYTES, 512 * 1024 * 1024),
  // Player
  siteUrl: process.env.SITE_URL || "http://localhost:8000",
  playerHtmlPath: process.env.PLAYER_HTML_PATH || "/code/common/replay-headless/dist/player.html",
  // Serve the player under a script-locking CSP (nonce). On by default: recordings are untrusted,
  // and the CSP is the backstop if the replay iframe sandbox ever regresses. ENABLE_PLAYER_CSP=0
  // is the escape hatch if a player build ships without the nonce placeholder.
  enablePlayerCsp: process.env.ENABLE_PLAYER_CSP !== "0"
};

// ../posthog-mcp-trial/nodejs/src/common/utils/env-utils.ts
function stringToBoolean(value, strict = false) {
  const stringValue = String(value).toLowerCase();
  const isStrictlyTrue = ["y", "yes", "t", "true", "on", "1"].includes(stringValue);
  if (isStrictlyTrue) {
    return true;
  }
  if (strict) {
    const isStrictlyFalse = ["n", "no", "f", "false", "off", "0"].includes(stringValue);
    return isStrictlyFalse ? false : null;
  }
  return false;
}
function determineNodeEnv() {
  let nodeEnvRaw = process.env.NODE_ENV;
  if (nodeEnvRaw) {
    nodeEnvRaw = nodeEnvRaw.toLowerCase();
    if (nodeEnvRaw.startsWith("test" /* Test */)) {
      return "test" /* Test */;
    }
    if (nodeEnvRaw.startsWith("dev" /* Development */)) {
      return "dev" /* Development */;
    }
  }
  if (stringToBoolean(process.env.DEBUG)) {
    return "dev" /* Development */;
  }
  return "prod" /* Production */;
}
var isTestEnv = () => determineNodeEnv() === "test" /* Test */;
var isProdEnv = () => determineNodeEnv() === "prod" /* Production */;

// scripts/rasterizer-logger.ts
var import_pino = __toESM(require("pino"));
var rootLogger = (0, import_pino.default)(
  {
    level: process.env.LOG_LEVEL || "warn",
    formatters: { level: (label) => ({ level: label }) },
    base: { source: "rasterizer" },
    timestamp: import_pino.default.stdTimeFunctions.isoTime
  },
  import_pino.default.destination(2)
);
function createLogger(bindings = {}) {
  return Object.keys(bindings).length ? rootLogger.child(bindings) : rootLogger;
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/egress-proxy.ts
var log = createLogger();
function resolveEgressProxyUrl() {
  const upstream = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  const killed = stringToBoolean((process.env.RASTERIZER_USE_PROXY ?? "").trim(), true) === false;
  if (killed) {
    log.warn(
      { RASTERIZER_USE_PROXY: process.env.RASTERIZER_USE_PROXY },
      "RASTERIZER_USE_PROXY disables the egress proxy \u2014 chrome and s3 will dial direct"
    );
    return null;
  }
  if (!upstream) {
    if (isProdEnv()) {
      throw new Error(
        "No egress proxy configured (HTTPS_PROXY/HTTP_PROXY): recordings are untrusted content, so production refuses to run without egress containment. Set the proxy URL, or set RASTERIZER_USE_PROXY=false to explicitly accept direct egress."
      );
    }
    return null;
  }
  return upstream;
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/metrics.ts
var import_prom_client3 = require("prom-client");

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/otel-metrics.ts
var import_api3 = require("@opentelemetry/api");

// ../posthog-mcp-trial/nodejs/src/common/metrics/exemplars.ts
var import_api = require("@opentelemetry/api");
var MAX_BUFFERED_EXEMPLARS = 512;
var buffer = /* @__PURE__ */ new Map();
function exemplarKey(instrumentName, attributes) {
  const sorted = Object.entries(attributes ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `${instrumentName}|${JSON.stringify(sorted)}`;
}
function offerExemplar(instrumentName, value, attributes) {
  const spanContext = import_api.trace.getActiveSpan()?.spanContext();
  if (!spanContext || !(0, import_api.isSpanContextValid)(spanContext) || !(spanContext.traceFlags & import_api.TraceFlags.SAMPLED)) {
    return;
  }
  const key = exemplarKey(instrumentName, attributes);
  if (!buffer.has(key) && buffer.size >= MAX_BUFFERED_EXEMPLARS) {
    return;
  }
  buffer.set(key, {
    value,
    timeUnixNano: (BigInt(Date.now()) * 1000000n).toString(),
    traceId: spanContext.traceId,
    spanId: spanContext.spanId
  });
}
function counterWithExemplars(instrumentName, counter) {
  return {
    add: (value, attributes, ctx) => {
      offerExemplar(instrumentName, value, attributes);
      counter.add(value, attributes, ctx);
    }
  };
}
function histogramWithExemplars(instrumentName, histogram) {
  return {
    record: (value, attributes, ctx) => {
      offerExemplar(instrumentName, value, attributes);
      histogram.record(value, attributes, ctx);
    }
  };
}

// ../posthog-mcp-trial/nodejs/src/common/metrics/instruments.ts
var createCounterWithExemplars = (meter, name, options) => counterWithExemplars(name, meter.createCounter(name, options));
var createHistogramWithExemplars = (meter, name, options) => histogramWithExemplars(name, meter.createHistogram(name, options));
function swallowing(record) {
  return (...args) => {
    try {
      record(...args);
    } catch {
    }
  };
}

// ../posthog-mcp-trial/nodejs/src/common/metrics/otlp-provider.ts
var import_resources = require("@opentelemetry/resources");
var import_sdk_metrics2 = require("@opentelemetry/sdk-metrics");
var import_semantic_conventions = require("@opentelemetry/semantic-conventions");
var import_os = require("os");

// ../posthog-mcp-trial/nodejs/src/common/metrics/otlp-json-exporter.ts
var import_api2 = require("@opentelemetry/api");
var import_sdk_metrics = require("@opentelemetry/sdk-metrics");

// ../posthog-mcp-trial/nodejs/src/common/utils/logger.ts
var import_pino2 = __toESM(require("pino"));
var logLevel = process.env.LOG_LEVEL || (isTestEnv() ? "warn" : "info");
var Logger = class {
  pino;
  prefix;
  transport;
  isShutdown = false;
  constructor(name) {
    this.prefix = `[${name.toUpperCase()}]`;
    if (isProdEnv()) {
      this.pino = (0, import_pino2.default)({
        // By default pino will log the level number. So we can easily unify
        // the log structure with other parts of the app e.g. the web
        // server, we output the level name rather than the number. This
        // way, e.g. we can easily ingest into Loki and query across
        // workloads for all `error` log levels.
        formatters: {
          level: (label) => {
            return { level: label };
          }
        },
        level: logLevel
      });
    } else {
      this.transport = import_pino2.default.transport({
        target: "pino-pretty",
        options: {
          sync: true,
          level: logLevel
        }
      });
      this.pino = (0, import_pino2.default)({ level: logLevel }, this.transport);
    }
  }
  _log(level, ...args) {
    if (this.isShutdown || !this.pino) {
      return;
    }
    const lastArg = args[args.length - 1];
    const extra = typeof lastArg === "object" && !(lastArg instanceof Error) ? lastArg : void 0;
    if (extra) {
      args.pop();
    }
    const msg = `${this.prefix} ${args.join(" ")}`;
    try {
      this.pino[level]({
        ...extra || {},
        msg
      });
    } catch (error) {
      if (error.message?.includes("worker has exited")) {
        return;
      }
      throw error;
    }
  }
  debug(...args) {
    this._log("debug", ...args);
  }
  info(...args) {
    this._log("info", ...args);
  }
  warn(...args) {
    this._log("warn", ...args);
  }
  error(...args) {
    this._log("error", ...args);
  }
  async shutdown() {
    this.isShutdown = true;
    try {
      if (this.transport) {
        await this.transport.end();
      }
    } catch {
    }
  }
};
var logger = new Logger(process.env.PLUGIN_SERVER_MODE ?? "MAIN");

// ../posthog-mcp-trial/nodejs/src/common/utils/request.ts
var import_promises = __toESM(require("dns/promises"));
var ipaddr = __toESM(require("ipaddr.js"));
var import_lru_cache = require("lru-cache");
var import_node_net = __toESM(require("node:net"));
var import_prom_client2 = require("prom-client");
var import_undici = require("undici");
var import_url = require("url");

// ../posthog-mcp-trial/nodejs/src/common/config.ts
var DEFAULT_THIRD_PARTY_REQUEST_TIMEOUT_MS = 3e3;
var PluginServerMode = /* @__PURE__ */ ((PluginServerMode2) => {
  PluginServerMode2["ingestion_v2"] = "ingestion-v2";
  PluginServerMode2["local_cdp"] = "local-cdp";
  PluginServerMode2["recordings_blob_ingestion_v2"] = "recordings-blob-ingestion-v2";
  PluginServerMode2["recordings_blob_ingestion_v2_overflow"] = "recordings-blob-ingestion-v2-overflow";
  PluginServerMode2["recordings_blob_ingestion_v2_ml_mirror"] = "recordings-blob-ingestion-v2-ml-mirror";
  PluginServerMode2["recordings_blob_ingestion_v2_ml_parquet_sink"] = "recordings-blob-ingestion-v2-ml-parquet-sink";
  PluginServerMode2["recordings_blob_ingestion_v2_ml_image_scrub"] = "recordings-blob-ingestion-v2-ml-image-scrub";
  PluginServerMode2["recordings_blob_ingestion_v2_ml_image_scrub_dlq_replay"] = "recordings-blob-ingestion-v2-ml-image-scrub-dlq-replay";
  PluginServerMode2["recordings_blob_ingestion_v2_ml_image_fetch"] = "recordings-blob-ingestion-v2-ml-image-fetch";
  PluginServerMode2["recordings_blob_ingestion_v2_ml_image_fetch_retry"] = "recordings-blob-ingestion-v2-ml-image-fetch-retry";
  PluginServerMode2["cdp_processed_events"] = "cdp-processed-events";
  PluginServerMode2["cdp_person_updates"] = "cdp-person-updates";
  PluginServerMode2["cdp_data_warehouse_events"] = "cdp-data-warehouse-events";
  PluginServerMode2["cdp_internal_events"] = "cdp-internal-events";
  PluginServerMode2["cdp_cyclotron_worker"] = "cdp-cyclotron-worker";
  PluginServerMode2["cdp_precalculated_filters"] = "cdp-precalculated-filters";
  PluginServerMode2["cdp_hogflow_subscription_matcher"] = "cdp-hogflow-subscription-matcher";
  PluginServerMode2["cdp_cohort_membership"] = "cdp-cohort-membership";
  PluginServerMode2["cdp_cyclotron_worker_hogflow"] = "cdp-cyclotron-worker-hogflow";
  PluginServerMode2["cdp_cyclotron_worker_email"] = "cdp-cyclotron-worker-email";
  PluginServerMode2["cdp_api"] = "cdp-api";
  PluginServerMode2["cdp_legacy_on_event"] = "cdp-legacy-on-event";
  PluginServerMode2["evaluation_scheduler"] = "evaluation-scheduler";
  PluginServerMode2["ingestion_logs"] = "ingestion-logs";
  PluginServerMode2["ingestion_error_tracking"] = "ingestion-errortracking";
  PluginServerMode2["ingestion_metrics"] = "ingestion-metrics";
  PluginServerMode2["cdp_cyclotron_worker_batch_resolve"] = "cdp-cyclotron-worker-batch-resolve";
  PluginServerMode2["cdp_cyclotron_v2_janitor"] = "cdp-cyclotron-v2-janitor";
  PluginServerMode2["cdp_rerun_worker"] = "cdp-rerun-worker";
  PluginServerMode2["cdp_dlq_replay"] = "cdp-dlq-replay";
  PluginServerMode2["recording_api"] = "recording-api";
  PluginServerMode2["ingestion_v2_combined"] = "ingestion-v2-combined";
  PluginServerMode2["ingestion_traces"] = "ingestion-traces";
  PluginServerMode2["cdp_hogflow_scheduler"] = "cdp-hogflow-scheduler";
  PluginServerMode2["ingestion_api"] = "ingestion-api";
  PluginServerMode2["push_api"] = "push-api";
  return PluginServerMode2;
})(PluginServerMode || {});
var stringToPluginServerMode = Object.fromEntries(
  Object.entries(PluginServerMode).map(([key, value]) => [
    value,
    PluginServerMode[key]
  ])
);
function getExternalRequestConfig() {
  return {
    EXTERNAL_REQUEST_TIMEOUT_MS: Number(process.env.EXTERNAL_REQUEST_TIMEOUT_MS ?? 3e3),
    EXTERNAL_REQUEST_THIRD_PARTY_TIMEOUT_MS: Number(
      process.env.EXTERNAL_REQUEST_THIRD_PARTY_TIMEOUT_MS ?? DEFAULT_THIRD_PARTY_REQUEST_TIMEOUT_MS
    ),
    EXTERNAL_REQUEST_CONNECT_TIMEOUT_MS: Number(process.env.EXTERNAL_REQUEST_CONNECT_TIMEOUT_MS ?? 3e3),
    EXTERNAL_REQUEST_KEEP_ALIVE_TIMEOUT_MS: Number(process.env.EXTERNAL_REQUEST_KEEP_ALIVE_TIMEOUT_MS ?? 1e4),
    EXTERNAL_REQUEST_CONNECTIONS: Number(process.env.EXTERNAL_REQUEST_CONNECTIONS ?? 500),
    EXTERNAL_REQUEST_H2_CONNECTIONS: Number(process.env.EXTERNAL_REQUEST_H2_CONNECTIONS ?? 8),
    EXTERNAL_REQUEST_PROXY_TEAMS: process.env.EXTERNAL_REQUEST_PROXY_TEAMS ?? "",
    EXTERNAL_REQUEST_DNS_ABSOLUTE_LOOKUP: process.env.EXTERNAL_REQUEST_DNS_ABSOLUTE_LOOKUP === "true",
    EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_MODE: process.env.EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_MODE ?? "off",
    EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_TTL_MS: Number(
      process.env.EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_TTL_MS ?? 1e4
    ),
    EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_MAX_ENTRIES: Number(
      process.env.EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_MAX_ENTRIES ?? 1e4
    )
  };
}

// ../posthog-mcp-trial/nodejs/src/common/config/matchers.ts
function buildIntegerMatcherWithPercentage(config2) {
  if (!config2 || config2.trim().length === 0) {
    return () => false;
  }
  if (config2.trim() === "*") {
    return () => true;
  }
  const parts = config2.split(",").map((s) => s.trim());
  const teamIds = /* @__PURE__ */ new Set();
  let percentage = 0;
  for (const part of parts) {
    if (part.startsWith("*:")) {
      percentage = parseFloat(part.slice(2));
    } else {
      const num = parseInt(part);
      if (!isNaN(num)) {
        teamIds.add(num);
      }
    }
  }
  return (teamId) => {
    if (teamIds.has(teamId)) {
      return true;
    }
    if (percentage > 0) {
      return Math.random() < percentage;
    }
    return false;
  };
}

// ../posthog-mcp-trial/nodejs/src/common/utils/cold-start-gate.ts
var MAX_TRACKED_ORIGINS = 1e4;
var ColdStartGate = class {
  constructor(idleTimeoutMs) {
    this.idleTimeoutMs = idleTimeoutMs;
  }
  origins = /* @__PURE__ */ new Map();
  nextSweepAt = 0;
  /**
   * Resolves once the request may start. `release` frees the held requests and must run when the probe has
   * response headers or has failed; for a request that is not the probe it does nothing. A held request whose
   * signal aborts rejects with the signal's reason, as undici does for a request it never sent. When a probe fails,
   * the next waiter becomes the probe, so a burst does not fan out after one failed connection.
   */
  async acquire(origin, signal) {
    for (; ; ) {
      const now = Date.now();
      const state = this.origins.get(origin);
      if (state?.probe) {
        await this.waitForProbe(state.probe, signal);
        continue;
      }
      if (state && state.warmUntil > now) {
        return { probe: false, release: () => {
        } };
      }
      let releaseProbe;
      const probe = new Promise((resolve) => releaseProbe = resolve);
      const probing = { warmUntil: state?.warmUntil ?? 0, probe };
      this.origins.set(origin, probing);
      this.sweep(now);
      return {
        probe: true,
        release: () => {
          if (probing.probe === probe) {
            probing.probe = null;
          }
          releaseProbe();
        }
      };
    }
  }
  touch(origin) {
    const warmUntil = Date.now() + this.idleTimeoutMs;
    const state = this.origins.get(origin);
    if (state) {
      state.warmUntil = warmUntil;
    } else {
      this.origins.set(origin, { warmUntil, probe: null });
    }
  }
  async waitForProbe(probe, signal) {
    if (!signal) {
      await probe;
      return;
    }
    if (signal.aborted) {
      throw signal.reason;
    }
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([probe, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  sweep(now) {
    if (this.origins.size < MAX_TRACKED_ORIGINS || now < this.nextSweepAt) {
      return;
    }
    this.nextSweepAt = now + 1e3;
    for (const [origin, state] of this.origins) {
      if (!state.probe && state.warmUntil <= now) {
        this.origins.delete(origin);
      }
    }
  }
};

// ../posthog-mcp-trial/nodejs/src/common/utils/fetch-attribution.ts
var import_node_async_hooks = require("node:async_hooks");
var fetchAttribution = new import_node_async_hooks.AsyncLocalStorage();

// ../posthog-mcp-trial/nodejs/src/common/utils/json-parse.ts
var import_perf_hooks = require("perf_hooks");
var import_prom_client = require("prom-client");
var jsonParseDurationMsSummary = new import_prom_client.Summary({
  name: "json_parse_duration_ms",
  help: "Time to parse JSON using different methods",
  labelNames: ["method"],
  percentiles: [0.5, 0.9, 0.95, 0.99]
});
function parseJSON(json) {
  const startTime = import_perf_hooks.performance.now();
  const result = JSON.parse(json);
  jsonParseDurationMsSummary.labels("native").observe(import_perf_hooks.performance.now() - startTime);
  return result;
}

// ../posthog-mcp-trial/nodejs/src/common/utils/request.ts
var import_undici2 = require("undici");
var requestConfig = getExternalRequestConfig();
var unsafeRequestCounter = new import_prom_client2.Counter({
  name: "node_request_unsafe",
  help: "Total number of unsafe requests detected and blocked",
  labelNames: ["reason"]
});
var externalRequestRouteCounter = new import_prom_client2.Counter({
  name: "node_external_request_route_total",
  help: "Third-party requests by egress route, proxy or direct",
  labelNames: ["route"]
});
var inflightExternalRequests = new import_prom_client2.Gauge({
  name: "cdp_http_inflight_requests",
  help: "Number of currently inflight external HTTP requests (undici). Use as HPA scaling metric for cdp-cyclotron-worker."
});
var dnsLookupDuration = new import_prom_client2.Histogram({
  name: "node_dns_lookup_duration_ms",
  help: "Duration of dns.lookup() for an external hostname, in milliseconds",
  labelNames: ["outcome"],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1e3, 2e3, 3e3, 5e3, 1e4]
});
var dnsLookupsInFlight = new import_prom_client2.Gauge({
  name: "node_dns_lookups_in_flight",
  help: "Number of dns.lookup() calls currently awaiting a result"
});
var dnsNegativeCacheCounter = new import_prom_client2.Counter({
  name: "node_dns_negative_cache_total",
  help: "Lookups the DNS negative cache skipped (hit), would have skipped in shadow mode (shadow_hit), or would have skipped although the hostname resolved (shadow_hit_resolved)",
  labelNames: ["result"]
});
var DNS_NEGATIVE_CACHE_MODES = ["off", "shadow", "enforce"];
var dnsNegativeCacheMode = requestConfig.EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_MODE;
if (!DNS_NEGATIVE_CACHE_MODES.includes(dnsNegativeCacheMode)) {
  throw new Error(
    `EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_MODE must be one of ${DNS_NEGATIVE_CACHE_MODES.join(", ")}, got '${dnsNegativeCacheMode}'`
  );
}
for (const name of [
  "EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_TTL_MS",
  "EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_MAX_ENTRIES"
]) {
  if (!Number.isInteger(requestConfig[name]) || requestConfig[name] < 1) {
    throw new Error(`${name} must be a positive integer, got ${process.env[name]}`);
  }
}
var dnsNegativeCache = dnsNegativeCacheMode === "off" ? null : new import_lru_cache.LRUCache({
  max: requestConfig.EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_MAX_ENTRIES,
  ttl: requestConfig.EXTERNAL_REQUEST_DNS_NEGATIVE_CACHE_TTL_MS
});
function dnsLookupName(hostname2) {
  return requestConfig.EXTERNAL_REQUEST_DNS_ABSOLUTE_LOOKUP && !hostname2.endsWith(".") && import_node_net.default.isIP(hostname2) === 0 ? `${hostname2}.` : hostname2;
}
var SecureRequestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SecureRequestError";
  }
};
var InvalidRequestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidRequestError";
  }
};
var ResolutionError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ResolutionError";
  }
};
function logBlockedUrlValidation(hostname2, resolvedIps) {
  logger.warn("[SSRF] Request blocked by URL validation check", {
    hostname: hostname2,
    resolvedIps,
    ...fetchAttribution.getStore()
  });
}
function validateUrl(url) {
  let parsedUrl;
  try {
    parsedUrl = new import_url.URL(url);
  } catch {
    throw new InvalidRequestError("Invalid URL");
  }
  const { hostname: hostname2, protocol } = parsedUrl;
  if (!hostname2) {
    throw new InvalidRequestError("No hostname");
  }
  if (!["http:", "https:"].includes(protocol)) {
    throw new InvalidRequestError("Scheme must be either HTTP or HTTPS");
  }
  return parsedUrl;
}
function validateHostnameIPLiteral(hostname2, allowUnsafe) {
  if (allowUnsafe) {
    return;
  }
  const bare = hostname2.startsWith("[") && hostname2.endsWith("]") ? hostname2.slice(1, -1) : hostname2;
  let parsed;
  try {
    parsed = ipaddr.parse(bare);
  } catch {
    return;
  }
  let ipv4 = null;
  if (isIPv4(parsed)) {
    ipv4 = parsed;
  } else if (parsed.isIPv4MappedAddress()) {
    ipv4 = parsed.toIPv4Address();
  } else {
    if (!isGlobalIPv6(parsed)) {
      unsafeRequestCounter.inc({ reason: "internal_ip_literal" });
      logBlockedUrlValidation(hostname2, [bare]);
      throw new SecureRequestError("Hostname is not allowed");
    }
    return;
  }
  if (!isGlobalIPv4(ipv4)) {
    unsafeRequestCounter.inc({ reason: "internal_ip_literal" });
    logBlockedUrlValidation(hostname2, [bare]);
    throw new SecureRequestError("Hostname is not allowed");
  }
}
function isGlobalIPv4(ip) {
  const [a, b, c, d] = ip.octets;
  if (a === 0) {
    return false;
  }
  if (ip.range() !== "unicast") {
    return false;
  }
  if (a === 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 255 && b === 255 && c === 255 && d === 255) {
    return false;
  }
  return true;
}
function isGlobalIPv6(ip) {
  const range = ip.range();
  return range === "unicast";
}
function isIPv4(addr) {
  return addr.kind().toLowerCase() === "ipv4";
}
async function staticLookupAsync(hostname2) {
  let addrinfo;
  const validAddrinfo = [];
  const cacheKey = hostname2.toLowerCase().replace(/\.$/, "");
  const cachedFailure = dnsNegativeCache?.has(cacheKey) ?? false;
  if (cachedFailure) {
    if (dnsNegativeCacheMode === "enforce") {
      dnsNegativeCacheCounter.inc({ result: "hit" });
      throw new ResolutionError("Invalid hostname");
    }
    dnsNegativeCacheCounter.inc({ result: "shadow_hit" });
  }
  const lookupStartedAt = performance.now();
  dnsLookupsInFlight.inc();
  try {
    addrinfo = await import_promises.default.lookup(dnsLookupName(hostname2), { all: true });
    dnsLookupDuration.observe({ outcome: "success" }, performance.now() - lookupStartedAt);
  } catch (error) {
    dnsLookupDuration.observe({ outcome: "failure" }, performance.now() - lookupStartedAt);
    if (!cachedFailure && error?.code === "ENOTFOUND") {
      dnsNegativeCache?.set(cacheKey, true);
    }
    throw new ResolutionError("Invalid hostname");
  } finally {
    dnsLookupsInFlight.dec();
  }
  if (cachedFailure) {
    dnsNegativeCacheCounter.inc({ result: "shadow_hit_resolved" });
  } else {
    dnsNegativeCache?.delete(cacheKey);
  }
  const resolvedIps = addrinfo.map((a) => a.address);
  for (const addrInfo of addrinfo) {
    const parsed = ipaddr.parse(addrInfo.address);
    let ipv4 = null;
    if (isIPv4(parsed)) {
      ipv4 = parsed;
    } else if (parsed.isIPv4MappedAddress()) {
      ipv4 = parsed.toIPv4Address();
    } else {
      const allowUnsafe2 = !isProdEnv();
      if (!allowUnsafe2 && !isGlobalIPv6(parsed)) {
        unsafeRequestCounter.inc({ reason: "internal_hostname" });
        logBlockedUrlValidation(hostname2, resolvedIps);
        throw new SecureRequestError("Hostname is not allowed");
      }
      validAddrinfo.push(addrInfo);
      continue;
    }
    const allowUnsafe = !isProdEnv();
    if (!allowUnsafe && !isGlobalIPv4(ipv4)) {
      unsafeRequestCounter.inc({ reason: "internal_hostname" });
      logBlockedUrlValidation(hostname2, resolvedIps);
      throw new SecureRequestError("Hostname is not allowed");
    }
    validAddrinfo.push(addrInfo);
  }
  if (validAddrinfo.length === 0) {
    unsafeRequestCounter.inc({ reason: "unable_to_resolve" });
    logBlockedUrlValidation(hostname2, resolvedIps);
    throw new ResolutionError(`Unable to resolve ${hostname2}`);
  }
  return validAddrinfo;
}
var httpStaticLookup = async (hostname2, _options, cb) => {
  try {
    const addrinfo = await staticLookupAsync(hostname2);
    cb(null, addrinfo);
  } catch (err) {
    cb(err, "", 4);
  }
};
var InsecureAgent = class extends import_undici.Agent {
  constructor() {
    super({
      keepAliveTimeout: requestConfig.EXTERNAL_REQUEST_KEEP_ALIVE_TIMEOUT_MS,
      connections: requestConfig.EXTERNAL_REQUEST_CONNECTIONS,
      // undici enables HTTP/2 by default. Internal services stay on HTTP/1.1 because nothing here needs multiplexing. HTTP/2 sessions also fail in different ways, with GOAWAY replays and refused streams.
      allowH2: false,
      connect: {
        timeout: requestConfig.EXTERNAL_REQUEST_CONNECT_TIMEOUT_MS
      }
    });
  }
};
var proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || "";
var proxyTeamMatcher = buildIntegerMatcherWithPercentage(requestConfig.EXTERNAL_REQUEST_PROXY_TEAMS);
var proxyRolloutPercentages = requestConfig.EXTERNAL_REQUEST_PROXY_TEAMS.split(",").map((part) => part.trim()).filter((part) => part.startsWith("*:")).map((part) => part.slice(2));
for (const rolloutPercentage of proxyRolloutPercentages) {
  const percentage = Number(rolloutPercentage);
  if (rolloutPercentage === "" || !Number.isFinite(percentage) || percentage < 0 || percentage > 1) {
    throw new Error(
      `EXTERNAL_REQUEST_PROXY_TEAMS takes a fraction between 0 and 1 after '*:', got '${rolloutPercentage}'`
    );
  }
}
var proxyRolloutConfigured = requestConfig.EXTERNAL_REQUEST_PROXY_TEAMS.trim().length > 0;
function useProxyForTeam() {
  if (!proxyUrl) {
    return false;
  }
  if (!proxyRolloutConfigured) {
    return true;
  }
  const teamId = fetchAttribution.getStore()?.teamId;
  return proxyTeamMatcher(typeof teamId === "number" ? teamId : 0);
}
var routeOf = (useProxy) => useProxy ? "proxy" : "direct";
function makeSecureDispatcher({
  useProxy,
  allowH2,
  keepAliveTimeoutMs = requestConfig.EXTERNAL_REQUEST_KEEP_ALIVE_TIMEOUT_MS
}) {
  const connections = allowH2 ? requestConfig.EXTERNAL_REQUEST_H2_CONNECTIONS : requestConfig.EXTERNAL_REQUEST_CONNECTIONS;
  if (useProxy) {
    return new import_undici.ProxyAgent({
      uri: proxyUrl,
      keepAliveTimeout: keepAliveTimeoutMs,
      connections,
      // undici 8 tunnels only https targets by default. The proxy applies its checks to the tunnel, so a plain
      // http target must not go to the proxy as an absolute-form request instead.
      proxyTunnel: true,
      allowH2,
      requestTls: { allowH2 },
      connectTimeout: requestConfig.EXTERNAL_REQUEST_CONNECT_TIMEOUT_MS,
      // undici ignores the abort signal of a request until the request has a connection. So the proxy client needs its own limit on the wait for a CONNECT answer. This limit is the connect timeout of the direct route.
      clientFactory: (origin, options) => new import_undici.Pool(origin, { ...options, headersTimeout: requestConfig.EXTERNAL_REQUEST_CONNECT_TIMEOUT_MS })
    });
  }
  return new import_undici.Agent({
    keepAliveTimeout: keepAliveTimeoutMs,
    connections,
    allowH2,
    connect: {
      lookup: httpStaticLookup,
      timeout: requestConfig.EXTERNAL_REQUEST_CONNECT_TIMEOUT_MS
    }
  });
}
var sharedSecureAgent = makeSecureDispatcher({ useProxy: false, allowH2: false });
var sharedSecureProxyAgent = proxyUrl ? makeSecureDispatcher({ useProxy: true, allowH2: false }) : null;
var sharedInsecureAgent = new InsecureAgent();
if (!Number.isInteger(requestConfig.EXTERNAL_REQUEST_H2_CONNECTIONS) || requestConfig.EXTERNAL_REQUEST_H2_CONNECTIONS < 1) {
  throw new Error(
    `EXTERNAL_REQUEST_H2_CONNECTIONS must be a positive integer, got ${process.env.EXTERNAL_REQUEST_H2_CONNECTIONS}`
  );
}
var sharedSecureH2Agents = {
  direct: /* @__PURE__ */ new Map(),
  proxy: /* @__PURE__ */ new Map()
};
var MAX_SECURE_H2_AGENTS = 8;
var MAX_H2_IDLE_TIMEOUT_MS = 2147483647;
var sharedAgentsClosed = false;
function getSecureH2Agent(useProxy, idleTimeoutMs = requestConfig.EXTERNAL_REQUEST_KEEP_ALIVE_TIMEOUT_MS) {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > MAX_H2_IDLE_TIMEOUT_MS) {
    throw new InvalidRequestError(`http2IdleTimeoutMs must be a number between 1 and ${MAX_H2_IDLE_TIMEOUT_MS}`);
  }
  const agents = sharedSecureH2Agents[routeOf(useProxy)];
  let agent = agents.get(idleTimeoutMs);
  if (!agent) {
    if (sharedAgentsClosed) {
      throw new import_undici.errors.ClientDestroyedError();
    }
    if (agents.size >= MAX_SECURE_H2_AGENTS) {
      throw new InvalidRequestError(`http2IdleTimeoutMs takes at most ${MAX_SECURE_H2_AGENTS} distinct values`);
    }
    agent = {
      dispatcher: makeSecureDispatcher({ useProxy, allowH2: true, keepAliveTimeoutMs: idleTimeoutMs }),
      gate: new ColdStartGate(idleTimeoutMs)
    };
    agents.set(idleTimeoutMs, agent);
  }
  return agent;
}
function getSecureDispatcher(options) {
  const useProxy = useProxyForTeam();
  const secure = options.allowH2 ? getSecureH2Agent(useProxy, options.http2IdleTimeoutMs) : {
    dispatcher: useProxy && sharedSecureProxyAgent ? sharedSecureProxyAgent : sharedSecureAgent,
    gate: null
  };
  externalRequestRouteCounter.inc({ route: routeOf(useProxy) });
  return secure;
}
function destroyBody(body) {
  try {
    body.on("error", () => {
    });
    body.destroy();
  } catch {
  }
}
function flattenHeaders(raw) {
  const headers = /* @__PURE__ */ Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    const singleValue = Array.isArray(value) ? value[0] : value;
    if (singleValue) {
      headers[key] = singleValue;
    }
  }
  return headers;
}
async function readAndDestroyBody(body) {
  const text = await body.text();
  destroyBody(body);
  return text;
}
async function _fetch(url, options = {}, dispatcher, defaultTimeoutMs = requestConfig.EXTERNAL_REQUEST_TIMEOUT_MS, lifecycle) {
  let parsed;
  try {
    parsed = new import_url.URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!parsed.hostname || !(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    throw new Error("URL must have HTTP or HTTPS protocol and a valid hostname");
  }
  options.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  let result;
  try {
    result = await (0, import_undici.request)(parsed.toString(), {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      dispatcher,
      // request() does not follow redirects, so a response can never bounce to an unvalidated host
      signal: lifecycle?.signal ?? (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : void 0)
    });
  } catch (error) {
    lifecycle?.onError();
    throw error;
  }
  lifecycle?.onHeaders();
  const headers = flattenHeaders(result.headers);
  let bodyPromise;
  const readBody = () => {
    if (!bodyPromise) {
      bodyPromise = readAndDestroyBody(result.body).finally(() => lifecycle?.onBodyDone());
    }
    return bodyPromise;
  };
  return {
    status: result.statusCode,
    headers,
    json: async () => parseJSON(await readBody()),
    text: async () => await readBody(),
    dump: () => {
      if (!bodyPromise) {
        bodyPromise = Promise.resolve("");
        destroyBody(result.body);
        lifecycle?.onBodyDone();
      }
      return Promise.resolve();
    }
  };
}
var coldStartGateCounter = new import_prom_client2.Counter({
  name: "node_request_cold_start_gate_total",
  help: "Requests the HTTP/2 cold-start gate saw: probes to a cold origin, requests held behind a probe, and probes that failed",
  labelNames: ["event"]
});
async function gatedLifecycle(gate, origin, signal) {
  if (!gate) {
    return void 0;
  }
  const { probe, release } = await gate.acquire(origin, signal);
  coldStartGateCounter.inc({ event: probe ? "probe" : "held" });
  return {
    signal,
    onHeaders: () => {
      gate.touch(origin);
      release();
    },
    onError: () => {
      if (probe) {
        coldStartGateCounter.inc({ event: "probe_failed" });
      }
      release();
    },
    onBodyDone: () => gate.touch(origin)
  };
}
async function internalFetch(url, options = {}) {
  return await _fetch(url, options, sharedInsecureAgent);
}
function orderedHeaderLines(raw) {
  if (Array.isArray(raw)) {
    const lines = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
      lines.push({ name: String(raw[index]).toLowerCase(), value: String(raw[index + 1]) });
    }
    return lines;
  }
  if (!raw || typeof raw !== "object") {
    return [];
  }
  return Object.entries(raw).flatMap(
    ([name, value]) => (Array.isArray(value) ? value : [value]).flatMap(
      (line) => line === void 0 ? [] : [{ name: name.toLowerCase(), value: String(line) }]
    )
  );
}
function flattenHeaderLines(lines) {
  const headers = /* @__PURE__ */ Object.create(null);
  for (const { name, value } of lines) {
    headers[name] ??= value;
  }
  return headers;
}
async function readCappedBody(body, maxBytes, retainPrefixOnOverflow) {
  const chunks = [];
  let total = 0;
  let overLimit = false;
  try {
    for await (const chunk of body) {
      const buffer2 = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - total;
      if (buffer2.length > remaining) {
        if (remaining > 0) {
          chunks.push(buffer2.subarray(0, remaining));
          total += remaining;
        }
        overLimit = true;
        if (!retainPrefixOnOverflow) {
          chunks.length = 0;
          total = 0;
        }
        break;
      }
      chunks.push(buffer2);
      total += buffer2.length;
    }
  } finally {
    destroyBody(body);
  }
  return { bytes: Buffer.concat(chunks, total), overLimit };
}
async function fetchStreamed(url, options) {
  const parsed = validateUrl(url);
  validateHostnameIPLiteral(parsed.hostname, !isProdEnv());
  inflightExternalRequests.inc();
  let result;
  let lifecycle;
  try {
    const { dispatcher, gate } = getSecureDispatcher(options);
    const signal = AbortSignal.timeout(options.timeoutMs);
    lifecycle = await gatedLifecycle(gate, parsed.origin, signal);
    result = await (0, import_undici.request)(parsed.toString(), {
      method: "GET",
      headers: options.headers,
      dispatcher,
      signal,
      responseHeaders: "raw"
    });
  } catch (error) {
    lifecycle?.onError();
    inflightExternalRequests.dec();
    throw error;
  }
  lifecycle?.onHeaders();
  let settled = false;
  const settle = () => {
    if (settled) {
      return false;
    }
    settled = true;
    lifecycle?.onBodyDone();
    inflightExternalRequests.dec();
    return true;
  };
  const headerLines = orderedHeaderLines(result.headers);
  const headers = flattenHeaderLines(headerLines);
  return {
    status: result.statusCode,
    headers,
    headerLines,
    read: async (maxBytes, retainPrefixOnOverflow = true) => {
      if (settled) {
        return { bytes: Buffer.alloc(0), overLimit: false };
      }
      try {
        return await readCappedBody(result.body, maxBytes, retainPrefixOnOverflow);
      } finally {
        settle();
      }
    },
    discard: () => {
      if (settle()) {
        destroyBody(result.body);
      }
    }
  };
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/otel-metrics.ts
var ACTIVITY_DURATION_BOUNDARIES = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800];
var instruments = null;
function getInstruments() {
  if (instruments === null) {
    const meter = import_api3.metrics.getMeter("recording-rasterizer");
    instruments = {
      activitiesTotal: createCounterWithExemplars(meter, "recording_rasterizer_activities_total", {
        description: "Number of rasterization activities completed"
      }),
      activityDuration: createHistogramWithExemplars(meter, "recording_rasterizer_activity_duration_seconds", {
        description: "Total time for the rasterization activity",
        unit: "s",
        advice: { explicitBucketBoundaries: ACTIVITY_DURATION_BOUNDARIES }
      }),
      errorsTotal: createCounterWithExemplars(meter, "recording_rasterizer_errors_total", {
        description: "Rasterization errors by code"
      })
    };
  }
  return instruments;
}
var recordActivity = swallowing((result, seconds) => {
  const { activitiesTotal, activityDuration } = getInstruments();
  activitiesTotal.add(1, { result });
  activityDuration.record(seconds, { result });
});
var recordError = swallowing((code, retryable) => {
  getInstruments().errorsTotal.add(1, { code, retryable: retryable.toString() });
});

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/metrics.ts
var QUANTILES = [0.5, 0.95, 0.99];
var MAX_AGE_SECONDS = 600;
var AGE_BUCKETS = 5;
var RasterizationMetrics = class {
  // --- Activity timing ---
  // Histogram, not Summary: the RasterizerHighActivityDuration alert aggregates
  // _bucket series across pods with histogram_quantile.
  static activityDuration = new import_prom_client3.Histogram({
    name: "recording_rasterizer_activity_duration_seconds",
    help: "Total time for the rasterization activity",
    labelNames: ["result"],
    buckets: ACTIVITY_DURATION_BOUNDARIES
  });
  static beginFrameStallDuration = new import_prom_client3.Summary({
    name: "recording_rasterizer_beginframe_stall_duration_seconds",
    help: "Duration of recovered beginFrame stalls; frames that hit the hard timeout are not recorded here",
    percentiles: QUANTILES,
    maxAgeSeconds: MAX_AGE_SECONDS,
    ageBuckets: AGE_BUCKETS
  });
  static setupDuration = new import_prom_client3.Summary({
    name: "recording_rasterizer_setup_duration_seconds",
    help: "Time spent on browser setup, player load, and recording data fetch",
    labelNames: ["result"],
    percentiles: QUANTILES,
    maxAgeSeconds: MAX_AGE_SECONDS,
    ageBuckets: AGE_BUCKETS
  });
  static captureDuration = new import_prom_client3.Summary({
    name: "recording_rasterizer_capture_duration_seconds",
    help: "Time spent on screen capture of the recording playback",
    labelNames: ["result"],
    percentiles: QUANTILES,
    maxAgeSeconds: MAX_AGE_SECONDS,
    ageBuckets: AGE_BUCKETS
  });
  static uploadDuration = new import_prom_client3.Summary({
    name: "recording_rasterizer_upload_duration_seconds",
    help: "Time spent uploading the video to S3",
    labelNames: ["result"],
    percentiles: QUANTILES,
    maxAgeSeconds: MAX_AGE_SECONDS,
    ageBuckets: AGE_BUCKETS
  });
  static activitiesTotal = new import_prom_client3.Counter({
    name: "recording_rasterizer_activities_total",
    help: "Number of rasterization activities completed",
    labelNames: ["result"]
  });
  // --- Video output ---
  static videoDuration = new import_prom_client3.Summary({
    name: "recording_rasterizer_video_duration_seconds",
    help: "Duration of the output video",
    percentiles: QUANTILES,
    maxAgeSeconds: MAX_AGE_SECONDS,
    ageBuckets: AGE_BUCKETS
  });
  static videoFileSize = new import_prom_client3.Summary({
    name: "recording_rasterizer_video_file_size_bytes",
    help: "Size of the output video file",
    percentiles: QUANTILES,
    maxAgeSeconds: MAX_AGE_SECONDS,
    ageBuckets: AGE_BUCKETS
  });
  static videoFramesTotal = new import_prom_client3.Counter({
    name: "recording_rasterizer_video_frames_total",
    help: "Total number of frames captured across all activities"
  });
  static recordingDuration = new import_prom_client3.Summary({
    name: "recording_rasterizer_recording_duration_seconds",
    help: "Total real-world duration of the recording including inactive periods",
    percentiles: QUANTILES,
    maxAgeSeconds: MAX_AGE_SECONDS,
    ageBuckets: AGE_BUCKETS
  });
  // --- Errors ---
  static errorsTotal = new import_prom_client3.Counter({
    name: "recording_rasterizer_errors_total",
    help: "Number of rasterization errors",
    labelNames: ["code", "retryable"]
  });
  // --- Browser pool ---
  static browserActive = new import_prom_client3.Gauge({
    name: "recording_rasterizer_browser_active",
    help: "Number of browser instances currently in use"
  });
  static browserIdle = new import_prom_client3.Gauge({
    name: "recording_rasterizer_browser_idle",
    help: "Number of idle browser instances in the pool"
  });
  static browserLaunchesTotal = new import_prom_client3.Counter({
    name: "recording_rasterizer_browser_launches_total",
    help: "Total number of browser instances launched"
  });
  static browserRecyclesTotal = new import_prom_client3.Counter({
    name: "recording_rasterizer_browser_recycles_total",
    help: "Total number of browser instances recycled due to usage limit"
  });
  static browserCrashesTotal = new import_prom_client3.Counter({
    name: "recording_rasterizer_browser_crashes_total",
    help: "Total number of browser instances that disconnected unexpectedly"
  });
  static unhandledRejectionsTotal = new import_prom_client3.Counter({
    name: "recording_rasterizer_unhandled_rejections_total",
    help: "Number of unhandled promise rejections suppressed by the worker guard"
  });
  // --- Concurrency ---
  static concurrentActivities = new import_prom_client3.Gauge({
    name: "recording_rasterizer_concurrent_activities",
    help: "Number of rasterization activities currently in flight"
  });
  // --- Observe methods ---
  static observeActivity(result, seconds) {
    this.activityDuration.labels({ result }).observe(seconds);
    this.activitiesTotal.labels({ result }).inc();
    recordActivity(result, seconds);
  }
  static observeBeginFrameStall(seconds) {
    this.beginFrameStallDuration.observe(seconds);
  }
  static observeSetup(result, seconds) {
    this.setupDuration.labels({ result }).observe(seconds);
  }
  static observeCapture(result, seconds) {
    this.captureDuration.labels({ result }).observe(seconds);
  }
  static observeUpload(result, seconds) {
    this.uploadDuration.labels({ result }).observe(seconds);
  }
  static observeVideo(durationS, fileSizeBytes, frameCount) {
    this.videoDuration.observe(durationS);
    this.videoFileSize.observe(fileSizeBytes);
    this.videoFramesTotal.inc(frameCount);
  }
  static observeRecordingDuration(seconds) {
    this.recordingDuration.observe(seconds);
  }
  static incrementError(code, retryable) {
    this.errorsTotal.labels({ code, retryable: String(retryable) }).inc();
    recordError(code, retryable);
  }
  static browserLaunched() {
    this.browserLaunchesTotal.inc();
  }
  static browserRecycled() {
    this.browserRecyclesTotal.inc();
  }
  static browserCrashed() {
    this.browserCrashesTotal.inc();
  }
  static incrementUnhandledRejection() {
    this.unhandledRejectionsTotal.inc();
  }
  // Labeled counters only expose series after the first increment; the
  // RasterizerMetricsAbsent alert needs activities_total present from pod start.
  static initialize() {
    this.activitiesTotal.labels({ result: "success" }).inc(0);
    this.activitiesTotal.labels({ result: "error" }).inc(0);
  }
  static setBrowserCounts(active, idle) {
    this.browserActive.set(active);
    this.browserIdle.set(idle);
  }
  static activityStarted() {
    this.concurrentActivities.inc();
  }
  static activityFinished() {
    this.concurrentActivities.dec();
  }
};

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/browser-pool.ts
var log2 = createLogger();
function resolveProxyArgs() {
  const upstream = resolveEgressProxyUrl();
  if (!upstream) {
    return [];
  }
  const u = new URL(upstream);
  if (!u.host) {
    throw new Error(
      `Egress proxy URL has no host \u2014 pass a fully-qualified URL like http://smokescreen:4750, not "${upstream}"`
    );
  }
  const proxyServer = `${u.protocol}//${u.host}`;
  log2.info({ proxy_server: proxyServer }, "chrome routing egress through proxy");
  return [
    `--proxy-server=${proxyServer}`,
    // Override Chrome's implicit loopback/link-local bypass so customer
    // DOM pointing at localhost / 127.0.0.1 / 169.254.169.254 (IMDS)
    // still goes through the proxy.
    "--proxy-bypass-list=<-loopback>"
  ];
}
var CHROME_ENV_ALLOWLIST = [
  // Chrome resolves its helper binaries through PATH.
  "PATH",
  // Chrome puts its profile, cache and crash state below HOME, or below the XDG paths when set.
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  // The container root filesystem is read-only, so temporary files must go where TMPDIR points.
  "TMPDIR",
  // The locale decides text shaping, and the timezone decides the timestamps the player draws.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // fontconfig reads these when an image keeps its font configuration outside /etc/fonts. Without
  // the fonts, the rendered frames fall back to boxes.
  "FONTCONFIG_PATH",
  "FONTCONFIG_FILE"
];
function chromeEnv() {
  const env = {};
  for (const name of CHROME_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== void 0) {
      env[name] = value;
    }
  }
  return env;
}
var BrowserPool = class {
  constructor(recycleAfter = config.browserRecycleAfter) {
    this.recycleAfter = recycleAfter;
  }
  slots = /* @__PURE__ */ new Map();
  idle = [];
  proxyArgs = resolveProxyArgs();
  shuttingDown = false;
  launchArgs() {
    return [
      "--disable-dev-shm-usage",
      // Pin crashpad to /tmp — the container root filesystem is read-only.
      "--crash-dumps-dir=/tmp/chrome-crash-dumps",
      "--mute-audio",
      ...this.proxyArgs,
      ...config.disableBrowserSecurity ? ["--disable-web-security"] : [],
      ...process.env.CHROME_HOST_RESOLVER_RULES ? [`--host-resolver-rules=${process.env.CHROME_HOST_RESOLVER_RULES}`] : []
    ];
  }
  async launchBrowser() {
    const browser = await (0, import_puppeteer_capture.launch)({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || void 0,
      args: this.launchArgs(),
      env: chromeEnv()
    });
    RasterizationMetrics.browserLaunched();
    const slot = { browser, usageCount: 0 };
    browser.on("disconnected", () => this.handleDisconnect(slot));
    return slot;
  }
  // A crashed browser must not be handed out again: evict it from the idle pool
  // and drop any page entries still pointing at it.
  handleDisconnect(slot) {
    if (slot.closing || this.shuttingDown) {
      return;
    }
    const idleIdx = this.idle.indexOf(slot);
    if (idleIdx !== -1) {
      this.idle.splice(idleIdx, 1);
    }
    for (const [page, s] of this.slots) {
      if (s === slot) {
        this.slots.delete(page);
      }
    }
    RasterizationMetrics.browserCrashed();
    log2.warn({ usage_count: slot.usageCount }, "browser disconnected unexpectedly, evicted from pool");
    RasterizationMetrics.setBrowserCounts(this.slots.size, this.idle.length);
  }
  async closeBrowser(slot) {
    slot.closing = true;
    try {
      await slot.browser.close();
    } catch (err) {
      log2.debug({ err }, "browser close failed, may already be dead");
    }
  }
  // puppeteer-capture only rejects a non-chrome-headless-shell binary when a capture attaches. This check
  // runs before the worker reports ready, so a bad PUPPETEER_EXECUTABLE_PATH fails the pod instead of every render.
  async launch() {
    if (this.idle.length > 0) {
      return;
    }
    const slot = await this.launchBrowser();
    const spawnfile = slot.browser.process()?.spawnfile;
    if (!spawnfile?.includes("chrome-headless-shell")) {
      await this.closeBrowser(slot);
      throw new Error(
        `Browser is not chrome-headless-shell: "${spawnfile ?? "unknown"}". Set PUPPETEER_EXECUTABLE_PATH to a chrome-headless-shell binary`
      );
    }
    this.idle.push(slot);
  }
  async getPage() {
    let slot;
    if (this.idle.length > 0) {
      slot = this.idle.pop();
    } else {
      slot = await this.launchBrowser();
    }
    let page;
    try {
      page = await slot.browser.newPage();
    } catch (err) {
      await this.closeBrowser(slot);
      throw err;
    }
    slot.usageCount++;
    this.slots.set(page, slot);
    RasterizationMetrics.setBrowserCounts(this.slots.size, this.idle.length);
    return page;
  }
  async releasePage(page) {
    const slot = this.slots.get(page);
    this.slots.delete(page);
    try {
      await page.close();
    } catch (err) {
      log2.debug({ err }, "page close failed, may already be closed");
    }
    if (!slot) {
      return;
    }
    if (slot.usageCount >= this.recycleAfter) {
      log2.info({ usage_count: slot.usageCount }, "recycling browser");
      RasterizationMetrics.browserRecycled();
      await this.closeBrowser(slot);
    } else if (this.idle.length >= config.maxIdleBrowsers) {
      log2.info({ idle: this.idle.length }, "idle pool full, closing browser");
      await this.closeBrowser(slot);
    } else {
      this.idle.push(slot);
    }
    RasterizationMetrics.setBrowserCounts(this.slots.size, this.idle.length);
  }
  async releaseAllPages() {
    const pages = [...this.slots.keys()];
    await Promise.all(pages.map((p) => this.releasePage(p)));
  }
  async shutdown() {
    this.shuttingDown = true;
    await this.releaseAllPages();
    await Promise.all(this.idle.map((slot) => this.closeBrowser(slot)));
    this.idle = [];
  }
  get stats() {
    let totalUsage = 0;
    for (const slot of this.slots.values()) {
      totalUsage += slot.usageCount;
    }
    for (const slot of this.idle) {
      totalUsage += slot.usageCount;
    }
    return { usageCount: totalUsage, activePages: this.slots.size };
  }
};

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/rasterize-file.ts
var fs5 = __toESM(require("fs/promises"));
var path = __toESM(require("path"));
var import_util2 = require("util");

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/capture-page.ts
var fs = __toESM(require("fs/promises"));

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/errors.ts
var RASTERIZATION_ERROR_CODES = [
  "UNKNOWN",
  "OTHER",
  "TIMEOUT",
  "CAPTURE_ABORTED",
  "TARGET_CLOSED",
  "BEGINFRAME_DEADLOCK",
  "INVALID_INPUT",
  "BLOCK_LISTING_FAILED",
  "RECORDING_TOO_LARGE",
  "S3_UPLOAD_FAILED",
  "S3_UPLOAD_UNDECODABLE_RESPONSE",
  "S3_DOWNLOAD_FAILED",
  "S3_DOWNLOAD_UNDECODABLE_RESPONSE",
  "S3_DOWNLOAD_EMPTY",
  "THUMBNAIL_EXTRACT_FAILED",
  "THUMBNAIL_EMPTY_OUTPUT",
  "NO_SNAPSHOTS",
  "INIT_FAILED",
  "DATA_LOAD_FAILED"
];
function toRasterizationErrorCode(code) {
  return RASTERIZATION_ERROR_CODES.includes(code) ? code : "OTHER";
}
var RasterizationError = class extends Error {
  retryable;
  code;
  constructor(message, retryable, code = "UNKNOWN", cause) {
    super(message);
    this.name = "RasterizationError";
    this.retryable = retryable;
    this.code = code;
    if (cause) {
      this.cause = cause;
    }
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      retryable: this.retryable,
      code: this.code
    };
  }
};

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/capture-page.ts
var BEGINFRAME_WARN_AFTER_MS = 15e3;
var playerHtmlCache = {
  _html: null,
  async load(path2) {
    const htmlPath = path2 || config.playerHtmlPath;
    this._html = await fs.readFile(htmlPath, "utf-8");
    return this._html;
  },
  get() {
    if (!this._html) {
      throw new Error("Player HTML not loaded \u2014 call playerHtmlCache.load() before recording");
    }
    return this._html;
  },
  reset() {
    this._html = null;
  }
};
var CapturePage = class _CapturePage {
  constructor(page, playerUrl, playerHtml) {
    this.page = page;
    this.playerUrl = playerUrl;
    this.playerHtml = playerHtml;
  }
  // Set at the site that detects a fatal cause (e.g. the beginFrame compositor deadlock)
  // so the generic captureStopped handler can attribute the abort instead of guessing.
  fatalError = null;
  /**
   * Prepare a pooled page for capture: set the viewport, optionally
   * wire up browser log forwarding, and hide grandchild frames.
   */
  static async prepare(page, viewport, playerUrl, playerHtml, captureLogs, log4) {
    if (captureLogs) {
      const browserLog = log4.child({ source: "browser" });
      page.on("console", (msg) => {
        const level = msg.type() === "error" ? "error" : msg.type() === "warn" ? "warn" : "info";
        browserLog[level](msg.text());
      });
      page.on("pageerror", (err) => browserLog.error({ type: "pageerror" }, err.message));
      page.on(
        "requestfailed",
        (req) => browserLog.error({ type: "requestfailed", url: req.url() }, req.failure()?.errorText || "unknown")
      );
    }
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    const mainFrame = page.mainFrame();
    const originalFrames = page.frames.bind(page);
    page.frames = () => originalFrames().filter((f) => f === mainFrame || f.parentFrame() === mainFrame);
    return new _CapturePage(page, playerUrl, playerHtml);
  }
  /**
   * Wrap timer and rAF APIs so that individual callback errors are
   * caught instead of crashing the entire capture. Must be called
   * AFTER recorder.start() — puppeteer-capture installs virtual-time
   * overrides on rAF/setTimeout/setInterval during start(), and this
   * wraps those overrides with try/catch.
   */
  async installCallbackErrorGuards() {
    await this.page.evaluate(() => {
      function wrapTimerApi(name) {
        const original = window[name];
        window[name] = (callback, ...rest) => {
          if (typeof callback !== "function") {
            return original(callback, ...rest);
          }
          return original(
            (...args) => {
              try {
                return callback(...args);
              } catch (e) {
                console.error(`[rasterizer] ${name} callback error (swallowed):`, e);
              }
            },
            ...rest
          );
        };
      }
      wrapTimerApi("requestAnimationFrame");
      wrapTimerApi("setTimeout");
      wrapTimerApi("setInterval");
    });
  }
  /**
   * Wrap CDP session to override screenshot format and gate beginFrame
   * on pending stylesheet requests. Must be called before captureVideo().
   */
  installCDPGuards(screenshotFormat, screenshotQuality, waitForRequestsSettled, log4 = createLogger()) {
    const page = this.page;
    const beginFrameTimeoutMs = config.beginFrameTimeoutMs;
    const originalCreateCDPSession = page.createCDPSession.bind(page);
    page.createCDPSession = async () => {
      const session = await originalCreateCDPSession();
      const originalSend = session.send.bind(session);
      session.send = async (method, ...args) => {
        if (method === "HeadlessExperimental.beginFrame") {
          const params = args[0] ?? {};
          if (screenshotFormat !== "png") {
            params.screenshot = { format: screenshotFormat };
            if (screenshotFormat === "jpeg" && screenshotQuality != null) {
              params.screenshot.quality = screenshotQuality;
            }
          }
          await waitForRequestsSettled();
          let timedOut = false;
          let stalled = false;
          let warnHandle;
          let hardHandle;
          const sendStart = Date.now();
          const timeout = new Promise((_, reject) => {
            warnHandle = setTimeout(() => {
              stalled = true;
              log4.warn({ params }, `beginFrame slow (>${BEGINFRAME_WARN_AFTER_MS / 1e3}s), waiting`);
              hardHandle = setTimeout(
                () => {
                  timedOut = true;
                  reject(new Error(`beginFrame timeout (${beginFrameTimeoutMs / 1e3}s)`));
                },
                Math.max(0, beginFrameTimeoutMs - BEGINFRAME_WARN_AFTER_MS)
              );
            }, BEGINFRAME_WARN_AFTER_MS);
          });
          try {
            const result = await Promise.race([originalSend(method, params), timeout]);
            if (stalled) {
              const stallS = (Date.now() - sendStart) / 1e3;
              RasterizationMetrics.observeBeginFrameStall(stallS);
              log4.warn({ stall_s: +stallS.toFixed(1) }, "beginFrame recovered after stall");
            }
            return result;
          } catch (err) {
            if (timedOut) {
              this.fatalError = new RasterizationError(
                `beginFrame timeout (${beginFrameTimeoutMs / 1e3}s) \u2014 compositor deadlock`,
                true,
                "BEGINFRAME_DEADLOCK"
              );
              log4.error({ params }, "beginFrame timed out, detaching CDP session");
              try {
                await session.detach();
              } catch {
              }
              throw this.fatalError;
            }
            throw err;
          } finally {
            clearTimeout(warnHandle);
            clearTimeout(hardHandle);
          }
        }
        return originalSend(method, ...args);
      };
      return session;
    };
  }
};

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/file-block-source.ts
var fs3 = __toESM(require("fs/promises"));
var import_util = require("util");
var import_zlib = require("zlib");

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/storage.ts
var import_client_s3 = require("@aws-sdk/client-s3");
var import_credential_provider_node = require("@aws-sdk/credential-provider-node");
var import_lib_storage = require("@aws-sdk/lib-storage");
var import_node_http_handler = require("@smithy/node-http-handler");
var fs2 = __toESM(require("fs"));
var import_https_proxy_agent = require("https-proxy-agent");
var import_stream = require("stream");
var import_promises2 = require("stream/promises");
var log3 = createLogger();

// ../posthog-mcp-trial/common/replay-headless/src/protocol.ts
var METADATA_FOOTER_HEIGHT_PX = 80;
var PLAYER_EMIT_FN = "__posthog_player_emit__";
var PLAYER_CONFIG_KEY = "__posthog_player_config__";
var PLAYER_FRAME_TIMELINE_KEY = "__posthog_frame_timeline__";
var PLAYER_START_EVENT = "posthog-player-start";
var BLOCK_REQUEST_PREFIX = "/__blocks/";

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/block-proxy.ts
var BlockProxy = class {
  constructor(cfg, log4 = createLogger()) {
    this.cfg = cfg;
    this.log = log4;
  }
  blocks = [];
  teamId = 0;
  sessionId = "";
  recordingApiToken = "";
  get blockCount() {
    return this.blocks.length;
  }
  // Compressed bytes the render will download, known before anything loads into the browser.
  // S3 Range bytes=start-end is inclusive, so each block spans end - start + 1 bytes.
  get totalCompressedBytes() {
    return this.blocks.reduce((sum, block) => sum + (block.end_byte - block.start_byte + 1), 0);
  }
  // Send both the legacy shared secret (when configured) and the relayed team-scoped JWT (when one
  // was minted upstream), so recording-api accepts either and rollout stays order-independent.
  authHeaders() {
    const headers = {};
    if (this.cfg.recordingApiSecret) {
      headers["X-Internal-Api-Secret"] = this.cfg.recordingApiSecret;
    }
    if (this.recordingApiToken) {
      headers["Authorization"] = `Bearer ${this.recordingApiToken}`;
    }
    return headers;
  }
  async fetchBlocks(input) {
    this.teamId = input.team_id;
    this.sessionId = input.session_id;
    this.recordingApiToken = input.recording_api_token ?? "";
    const url = `${this.cfg.recordingApiBaseUrl}/api/projects/${input.team_id}/recordings/${encodeURIComponent(
      input.session_id
    )}/blocks`;
    try {
      const resp = await internalFetch(url, {
        headers: this.authHeaders(),
        timeoutMs: this.cfg.blockListingTimeoutMs
      });
      if (resp.status < 200 || resp.status >= 300) {
        const body = await resp.text();
        const retryable = resp.status >= 500 || [404, 408, 429].includes(resp.status);
        throw new RasterizationError(
          `Failed to fetch block listing: ${resp.status} - ${body}`,
          retryable,
          "BLOCK_LISTING_FAILED"
        );
      }
      const data = await resp.json();
      if (!Array.isArray(data.blocks)) {
        throw new RasterizationError(
          `Invalid block listing response: expected blocks array, got ${typeof data.blocks}`,
          false,
          "BLOCK_LISTING_FAILED"
        );
      }
      this.blocks = data.blocks;
      return this.blocks.length;
    } catch (err) {
      if (err instanceof RasterizationError) {
        throw err;
      }
      throw new RasterizationError(
        `Failed to fetch block listing: ${err?.message ?? String(err)}`,
        true,
        "BLOCK_LISTING_FAILED",
        err
      );
    }
  }
  async handleRequest(request2, path2) {
    try {
      const index = parseInt(path2.slice(BLOCK_REQUEST_PREFIX.length), 10);
      if (isNaN(index) || index < 0 || index >= this.blocks.length) {
        this.log.warn({ path: path2, index, blockCount: this.blocks.length }, "block not found");
        await request2.respond({ status: 404, body: "block not found" });
        return;
      }
      const block = this.blocks[index];
      const params = new URLSearchParams({
        key: block.key,
        start_byte: String(block.start_byte),
        end_byte: String(block.end_byte),
        decompress: "true"
      });
      const apiBase = `${this.cfg.recordingApiBaseUrl}/api/projects`;
      const url = `${apiBase}/${this.teamId}/recordings/${encodeURIComponent(this.sessionId)}/block?${params}`;
      const resp = await internalFetch(url, {
        headers: this.authHeaders()
      });
      if (resp.status < 200 || resp.status >= 300) {
        const text = await resp.text();
        this.log.warn({ index, status: resp.status, body: text }, "upstream block fetch failed");
        await request2.respond({ status: resp.status, body: text });
        return;
      }
      const contentType = resp.headers["content-type"] || "application/octet-stream";
      await request2.respond({
        status: resp.status,
        contentType,
        body: await resp.text()
      });
    } catch (err) {
      this.log.error({ path: path2, err }, "block proxy failed");
      try {
        await request2.respond({ status: 502, body: "block proxy error" });
      } catch (respondErr) {
        this.log.debug({ path: path2, respondErr }, "could not send 502 response, page likely closed");
      }
    }
  }
};

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/file-block-source.ts
var ZSTD_MAGIC = Buffer.from([40, 181, 47, 253]);
var zstdDecompressAsync = (0, import_util.promisify)(import_zlib.zstdDecompress);
var FileBlockSource = class {
  constructor(filePath, maxDecompressedBytes) {
    this.filePath = filePath;
    this.maxDecompressedBytes = maxDecompressedBytes;
  }
  fileBytes = null;
  get blockCount() {
    return this.fileBytes === null ? 0 : 1;
  }
  get totalCompressedBytes() {
    return this.fileBytes ?? 0;
  }
  // Size only: the recorder's size gate runs on it before anything is read or decompressed.
  async fetchBlocks() {
    this.fileBytes = (await fs3.stat(this.filePath)).size;
    return this.blockCount;
  }
  async handleRequest(request2, path2) {
    if (path2 !== `${BLOCK_REQUEST_PREFIX}0` || this.fileBytes === null) {
      await request2.respond({ status: 404, body: "block not found" });
      return;
    }
    try {
      const raw = await fs3.readFile(this.filePath);
      const body = raw.subarray(0, 4).equals(ZSTD_MAGIC) ? await zstdDecompressAsync(raw, { maxOutputLength: this.maxDecompressedBytes }) : raw;
      await request2.respond({ status: 200, contentType: "text/plain", body });
    } catch {
      try {
        await request2.respond({ status: 502, body: "block read failed" });
      } catch {
      }
    }
  }
};

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/utils.ts
function elapsed(startHr) {
  const [s, ns] = process.hrtime(startHr);
  return Math.round((s + ns / 1e9) * 1e3) / 1e3;
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/capture.ts
var fs4 = __toESM(require("fs/promises"));
var import_puppeteer_capture2 = require("puppeteer-capture");
async function capturePlayback(player, captureConfig, outputPath, onProgress, progress = null, log4 = createLogger()) {
  const captureStart = process.hrtime();
  const ffmpegStderr = [];
  let frameCount = 0;
  player.prepareBrowserForCapture(captureConfig.screenshotFormat, captureConfig.screenshotQuality);
  const page = player.page;
  const recorder = await (0, import_puppeteer_capture2.capture)(page, {
    fps: captureConfig.captureFps,
    format: async () => {
    },
    // no-op — ffmpegOutputOpts carries all format settings
    // eslint-disable-next-line @typescript-eslint/require-await
    customFfmpegConfig: async (ffmpeg) => {
      ffmpeg.outputOptions(captureConfig.ffmpegOutputOpts);
      for (const filter of captureConfig.ffmpegVideoFilters) {
        ffmpeg.videoFilters(filter);
      }
      ffmpeg.on("start", (cmd) => log4.info({ cmd }, "ffmpeg started"));
      ffmpeg.on("stderr", (line) => ffmpegStderr.push(line));
      ffmpeg.on("error", (err) => log4.error({ err, stderr: ffmpegStderr.slice(-20) }, "ffmpeg error"));
    },
    ffmpeg: process.env.FFMPEG_PATH || void 0
  });
  const progressInterval = Math.max(10, captureConfig.captureFps);
  recorder.on("frameCaptured", () => {
    frameCount++;
    if (progress) {
      progress.frame = frameCount;
    }
    if (frameCount % progressInterval === 0) {
      log4.info(
        {
          frame: frameCount,
          virtual_s: +(frameCount / captureConfig.captureFps).toFixed(1),
          wall_s: +elapsed(captureStart).toFixed(1)
        },
        "capture progress"
      );
      onProgress();
    }
  });
  recorder.on("frameCaptureFailed", (reason) => {
    log4.error({ err: reason, frames: frameCount }, "frame capture failed");
  });
  let captureDone = false;
  const onPageClose = () => {
    if (!captureDone) {
      log4.error({ frames: frameCount }, "page closed during capture");
    }
  };
  const onPageError = (err) => {
    if (!captureDone) {
      log4.error({ err, frames: frameCount }, "page error during capture");
    }
  };
  page.on("close", onPageClose);
  page.on("error", onPageError);
  let stopResult = void 0;
  let captureStopSettle = null;
  const onCaptureStopped = () => {
    if (captureDone || player.isEnded() || frameCount >= captureConfig.trimFrameLimit) {
      log4.info({ frames: frameCount }, "capture stopped after playback ended");
      stopResult = null;
    } else {
      log4.error({ stderr: ffmpegStderr.slice(-20), frames: frameCount }, "capture stopped unexpectedly");
      stopResult = player.fatalError ?? new RasterizationError("capture stopped unexpectedly", true, "CAPTURE_ABORTED");
    }
    captureStopSettle?.(stopResult);
  };
  recorder.on("captureStopped", onCaptureStopped);
  let virtualElapsed = 0;
  let truncated = false;
  let preRollFrames = 0;
  try {
    await recorder.start(outputPath);
    const vp = page.viewport();
    log4.info({ fps: captureConfig.captureFps, width: vp?.width, height: vp?.height }, "capture started");
    await player.installCallbackErrorGuards();
    await player.startPlayback();
    preRollFrames = frameCount;
    log4.info({ pre_roll_frames: preRollFrames }, "playback started");
    const checkIntervalMs = 250;
    while (virtualElapsed < captureConfig.maxVirtualTimeMs) {
      if (stopResult !== void 0) {
        if (stopResult) {
          throw stopResult;
        }
        log4.info({ frames: frameCount }, "capture already stopped, ending loop");
        break;
      }
      await new Promise((resolve, reject) => {
        captureStopSettle = (err) => err ? reject(err) : resolve();
        Promise.resolve(recorder.waitForTimeout(checkIntervalMs)).then(resolve, reject);
      });
      captureStopSettle = null;
      virtualElapsed += checkIntervalMs;
      if (frameCount >= captureConfig.trimFrameLimit) {
        log4.info({ trim_s: captureConfig.trim, frames: frameCount }, "trim limit reached");
        break;
      }
      const playerError = player.getError();
      if (playerError) {
        throw playerError;
      }
      if (player.isEnded()) {
        log4.info({ virtual_s: virtualElapsed / 1e3, frames: frameCount }, "recording ended");
        break;
      }
    }
    if (virtualElapsed >= captureConfig.maxVirtualTimeMs) {
      log4.warn(
        { max_virtual_s: captureConfig.maxVirtualTimeMs / 1e3, frames: frameCount },
        "max virtual time reached, truncating"
      );
      truncated = true;
    }
  } finally {
    captureDone = true;
    captureStopSettle = null;
    page.off("close", onPageClose);
    page.off("error", onPageError);
    recorder.off("captureStopped", onCaptureStopped);
    try {
      await recorder.stop();
    } catch (stopErr) {
      if (stopErr instanceof Error && stopErr.message === "Capture is not in progress") {
        log4.info({ frames: frameCount }, "recorder already stopped");
      } else {
        log4.error({ err: stopErr, frames: frameCount }, "recorder.stop() error (root cause)");
      }
    }
  }
  let fileSize = 0;
  try {
    const rawStat = await fs4.stat(outputPath);
    fileSize = rawStat.size;
  } catch {
    log4.warn("output file missing after capture \u2014 ffmpeg may have failed to start");
  }
  log4.info({ file_size_bytes: fileSize }, "capture stopped");
  const inactivityPeriods = player.getInactivityPeriods();
  const rawDurationS = frameCount / captureConfig.outputFps;
  const captureDurationS = captureConfig.trim ? Math.min(rawDurationS, captureConfig.trim) : rawDurationS;
  return {
    capture_duration_s: captureDurationS,
    frame_count: frameCount,
    truncated,
    inactivity_periods: inactivityPeriods,
    frame_session_ms: await player.readFrameTimeline(),
    pre_roll_frames: preRollFrames,
    timings: { setup_s: 0, capture_s: elapsed(captureStart) }
  };
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/config.ts
var DEFAULT_PLAYBACK_SPEED = 4;
var DEFAULT_FPS = 24;
var GIF_MAX_FPS = 12;
var SESSION_ID_RE = /^(?!\.+$)[A-Za-z0-9_.:-]{1,200}$/;
function toFiniteNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new RasterizationError(`${field} must be a finite number, got: ${String(value)}`, false, "INVALID_INPUT");
  }
  return n;
}
function validateInput(input) {
  if (!input.session_id) {
    throw new RasterizationError("session_id is required", false, "INVALID_INPUT");
  }
  if (!SESSION_ID_RE.test(input.session_id)) {
    throw new RasterizationError("session_id contains illegal characters", false, "INVALID_INPUT");
  }
  if (!input.team_id || input.team_id <= 0) {
    throw new RasterizationError("team_id must be a positive integer", false, "INVALID_INPUT");
  }
  if (input.playback_speed !== void 0 && input.playback_speed < 1) {
    throw new RasterizationError(
      `playback_speed must be >= 1, got: ${input.playback_speed}`,
      false,
      "INVALID_INPUT"
    );
  }
  if (input.max_virtual_time != null && input.max_virtual_time <= 0) {
    throw new RasterizationError(
      `max_virtual_time must be positive, got: ${input.max_virtual_time}`,
      false,
      "INVALID_INPUT"
    );
  }
  if (input.recording_fps !== void 0 && input.recording_fps <= 0) {
    throw new RasterizationError(
      `recording_fps must be positive, got: ${input.recording_fps}`,
      false,
      "INVALID_INPUT"
    );
  }
  if (input.trim != null && input.trim <= 0) {
    throw new RasterizationError(`trim must be positive, got: ${input.trim}`, false, "INVALID_INPUT");
  }
  if (input.screenshot_quality != null && (input.screenshot_quality < 1 || input.screenshot_quality > 100)) {
    throw new RasterizationError(
      `screenshot_quality must be between 1 and 100, got: ${input.screenshot_quality}`,
      false,
      "INVALID_INPUT"
    );
  }
}
function buildCaptureConfig(input) {
  const playbackSpeed = input.playback_speed ? toFiniteNumber(input.playback_speed, "playback_speed") : DEFAULT_PLAYBACK_SPEED;
  let outputFps = input.recording_fps ? toFiniteNumber(input.recording_fps, "recording_fps") : DEFAULT_FPS;
  const outputFormat = input.output_format || "mp4";
  if (outputFormat === "gif") {
    outputFps = Math.min(outputFps, GIF_MAX_FPS);
  }
  const trim = input.trim ? toFiniteNumber(input.trim, "trim") : void 0;
  const captureFps = outputFps * playbackSpeed;
  const ffmpegOutputOpts = outputFormat === "webm" ? (
    // Default libvpx-vp9 settings (deadline good, cpu-used 0) encode at single-digit fps;
    // realtime deadline with row multithreading keeps encode well ahead of capture.
    ["-f webm", "-c:v libvpx-vp9", "-crf 30", "-b:v 0", "-deadline realtime", "-cpu-used 5", "-row-mt 1"]
  ) : outputFormat === "gif" ? ["-f gif", "-c:v gif", "-loop", "0"] : ["-f mp4", "-c:v libx264", "-preset veryfast", "-crf 23", "-pix_fmt yuv420p", "-movflags +faststart"];
  if (outputFormat !== "gif") {
    ffmpegOutputOpts.push("-threads 2");
  }
  ffmpegOutputOpts.push(`-r ${outputFps}`);
  if (trim) {
    ffmpegOutputOpts.push(`-t ${trim}`);
  }
  const ffmpegVideoFilters = [];
  if (outputFormat !== "gif") {
    ffmpegVideoFilters.push("pad=ceil(iw/2)*2:ceil(ih/2)*2");
  }
  if (playbackSpeed > 1) {
    ffmpegVideoFilters.push(`setpts=${playbackSpeed}*PTS`);
    ffmpegVideoFilters.push(`fps=${outputFps}`);
  }
  if (outputFormat === "gif") {
    ffmpegVideoFilters.push("scale=800:-2:flags=lanczos");
    ffmpegVideoFilters.push(
      "split[s0][s1];[s0]palettegen=stats_mode=single[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
    );
  }
  return {
    captureFps,
    outputFps,
    playbackSpeed,
    trim,
    trimFrameLimit: trim ? trim * outputFps : Infinity,
    maxVirtualTimeMs: input.max_virtual_time ? input.max_virtual_time * 1e3 : Infinity,
    outputFormat,
    ffmpegOutputOpts,
    ffmpegVideoFilters,
    screenshotFormat: input.screenshot_format || config.screenshotFormat,
    screenshotQuality: input.screenshot_quality ?? config.screenshotJpegQuality
  };
}
function buildPlayerConfig(input, playbackSpeed, blockCount) {
  return {
    teamId: input.team_id,
    sessionId: input.session_id,
    playbackSpeed,
    blockCount,
    skipInactivity: input.skip_inactivity !== false,
    mouseTail: input.mouse_tail !== false,
    showMetadataFooter: input.show_metadata_footer,
    startOffsetS: input.start_offset_s,
    endOffsetS: input.end_offset_s,
    viewportEvents: input.viewport_events || []
  };
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/request-interceptor.ts
var import_node_crypto = require("node:crypto");
var import_node_util = require("node:util");
var import_node_zlib = require("node:zlib");
var PROXY_TIMEOUT_MS = 1e4;
var MAX_STYLESHEET_BYTES = 10 * 1024 * 1024;
var MAX_CONTENT_ENCODING_LAYERS = 2;
var DECODERS = /* @__PURE__ */ new Map([
  ["gzip", (0, import_node_util.promisify)(import_node_zlib.gunzip)],
  ["x-gzip", (0, import_node_util.promisify)(import_node_zlib.gunzip)],
  ["deflate", (0, import_node_util.promisify)(import_node_zlib.inflate)],
  ["br", (0, import_node_util.promisify)(import_node_zlib.brotliDecompress)]
]);
var NONCE_PLACEHOLDER = "__CSP_NONCE__";
var RequestInterceptor = class {
  constructor(capturePage, blockProxy, log4 = createLogger(), enablePlayerCsp = config.enablePlayerCsp) {
    this.capturePage = capturePage;
    this.blockProxy = blockProxy;
    this.log = log4;
    this.enablePlayerCsp = enablePlayerCsp;
    this.mainFrame = capturePage.page.mainFrame();
  }
  tracked = /* @__PURE__ */ new Set();
  onSettled = null;
  mainFrame;
  async install() {
    const page = this.capturePage.page;
    page.on("requestfinished", (req) => this.removeTracked(req));
    page.on("requestfailed", (req) => this.removeTracked(req));
    await page.setRequestInterception(true);
    page.on("request", (request2) => this.handleRequest(request2));
  }
  /** Resolves when all tracked stylesheet requests have a response. */
  waitForSettled() {
    if (this.tracked.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.onSettled = resolve;
    });
  }
  handleRequest(request2) {
    const url = request2.url();
    if (url === this.capturePage.playerUrl) {
      this.servePlayer(request2);
      return;
    }
    let path2;
    try {
      path2 = new URL(url).pathname;
    } catch {
      void request2.continue();
      return;
    }
    if (path2.startsWith(BLOCK_REQUEST_PREFIX)) {
      void this.blockProxy.handleRequest(request2, path2);
      return;
    }
    if (request2.frame() !== this.mainFrame) {
      const type = request2.resourceType();
      if (type === "stylesheet") {
        this.tracked.add(request2);
        void this.proxyStylesheet(request2);
        return;
      }
      if (type === "media") {
        void request2.abort();
        return;
      }
    }
    void request2.continue();
  }
  /**
   * Serve the player document. When {@link enablePlayerCsp} is set, it goes out under a
   * Content-Security-Policy that confines script execution to our own bundle via a per-response
   * nonce. Recordings are untrusted, so this stops a malicious snapshot from running an inline
   * event handler (e.g. a copied `onerror`) in the player origin — defense in depth behind
   * sanitizing the DOM itself.
   *
   * Only script execution is locked down. Resource directives (img/style/font/media/
   * connect/frame) are intentionally left unset so recorded pages keep loading assets from
   * arbitrary third-party hosts, which is the whole point of the replay. `worker-src blob:`
   * keeps hls.js's transmux worker alive; the replay iframe is scriptless (`allow-same-origin`
   * sandbox with no `allow-scripts`), so inheriting this policy costs it nothing.
   *
   * The CSP is opt-in (ENABLE_PLAYER_CSP) so it can be verified in dev before production; when
   * off, the placeholder is stripped and the player is served as it was before this feature.
   */
  servePlayer(request2) {
    const playerHtml = this.capturePage.playerHtml;
    if (!this.enablePlayerCsp) {
      void request2.respond({
        status: 200,
        contentType: "text/html",
        body: playerHtml.replace(` nonce="${NONCE_PLACEHOLDER}"`, "")
      });
      return;
    }
    const nonce = (0, import_node_crypto.randomBytes)(16).toString("base64");
    const body = playerHtml.replace(NONCE_PLACEHOLDER, () => nonce);
    if (!body.includes(nonce) || body.includes(NONCE_PLACEHOLDER)) {
      this.log.error(
        { playerUrl: this.capturePage.playerUrl },
        "player HTML nonce placeholder missing or duplicated; refusing to serve without a working CSP nonce"
      );
      void request2.respond({ status: 500, contentType: "text/plain", body: "player nonce injection failed" });
      return;
    }
    void request2.respond({
      status: 200,
      contentType: "text/html",
      headers: {
        "Content-Security-Policy": `script-src 'nonce-${nonce}'; worker-src blob:; object-src 'none'`
      },
      body
    });
  }
  removeTracked(req) {
    if (this.tracked.delete(req) && this.tracked.size === 0 && this.onSettled) {
      this.onSettled();
      this.onSettled = null;
    }
  }
  async proxyStylesheet(request2) {
    const url = request2.url();
    try {
      const browserHeaders = request2.headers();
      const headers = {};
      for (const name of ["accept", "accept-language", "user-agent"]) {
        if (browserHeaders[name]) {
          headers[name] = browserHeaders[name];
        }
      }
      const resp = await fetchStreamed(url, { headers, timeoutMs: PROXY_TIMEOUT_MS });
      const { bytes, overLimit } = await resp.read(MAX_STYLESHEET_BYTES, false);
      if (overLimit) {
        throw new Error(`stylesheet is larger than ${MAX_STYLESHEET_BYTES} bytes`);
      }
      const body = await decodeContentEncoding(bytes, resp.headerLines);
      await request2.respond({
        status: resp.status,
        contentType: resp.headers["content-type"] || "text/css",
        // A `<link crossorigin>` makes Chrome CORS-check this response, and without the header it
        // drops the stylesheet and the frame renders unstyled. The fetch above carries no credentials.
        headers: { "access-control-allow-origin": "*" },
        body
      });
    } catch (err) {
      this.log.warn({ url, err: err?.message }, "stylesheet proxy failed, responding empty");
      try {
        await request2.respond({ status: 200, contentType: "text/css", body: "" });
      } catch {
        this.removeTracked(request2);
      }
    }
  }
};
async function decodeContentEncoding(body, headerLines) {
  const codings = headerLines.filter((line) => line.name === "content-encoding").flatMap((line) => line.value.split(",")).map((coding) => coding.trim().toLowerCase()).filter((coding) => coding !== "" && coding !== "identity");
  if (codings.length === 0 || body.length === 0) {
    return body;
  }
  if (codings.length > MAX_CONTENT_ENCODING_LAYERS) {
    throw new Error(`too many content encodings: ${codings.join(", ")}`);
  }
  let decoded = body;
  for (const coding of codings.reverse()) {
    const decode = DECODERS.get(coding);
    if (!decode) {
      throw new Error(`unsupported content encoding: ${coding}`);
    }
    decoded = await decode(decoded, { maxOutputLength: MAX_STYLESHEET_BYTES });
  }
  return decoded;
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/player.ts
var PlayerController = class {
  capturePage;
  log;
  interceptor;
  onProgress;
  state = {
    ended: false,
    inactivityPeriods: [],
    frameSessionMs: []
  };
  startedResolve = null;
  errorReject = null;
  playbackError = null;
  resetStaleTimer = null;
  constructor(capturePage, blockProxy, onProgress, log4 = createLogger()) {
    this.capturePage = capturePage;
    this.log = log4;
    this.onProgress = onProgress;
    this.interceptor = new RequestInterceptor(capturePage, blockProxy, this.log);
  }
  get page() {
    return this.capturePage.page;
  }
  get fatalError() {
    return this.capturePage.fatalError;
  }
  toError(err) {
    return new RasterizationError(`[${err.code}] ${err.message}`, err.retryable, toRasterizationErrorCode(err.code));
  }
  rejectWithError(err) {
    const rasterErr = this.toError(err);
    if (this.errorReject) {
      this.errorReject(rasterErr);
      this.errorReject = null;
    } else {
      this.playbackError = rasterErr;
    }
  }
  handleMessage(msg) {
    switch (msg.type) {
      case "loading_progress":
        this.resetStaleTimer?.();
        this.onProgress();
        this.log.info({ loaded: msg.loaded, total: msg.total }, "loading blocks");
        break;
      case "started":
        this.startedResolve?.();
        this.startedResolve = null;
        break;
      case "ended":
        this.state.ended = true;
        break;
      case "error":
        this.rejectWithError(msg);
        break;
      case "inactivity_periods":
        this.state.inactivityPeriods = msg.periods;
        break;
      case "frame_timeline":
        this.state.frameSessionMs = msg.frameSessionMs;
        break;
    }
  }
  /**
   * Wait for `promise` to resolve, but reject if `ms` elapses or the
   * player sends an error. When `resetOnProgress` is true the timer
   * resets on each loading_progress message — so we only time out when
   * progress stalls, not when loading takes a long time overall.
   */
  awaitWithTimeout(promise, ms, timeoutMsg, resetOnProgress = false) {
    if (this.playbackError) {
      return Promise.reject(this.playbackError);
    }
    return new Promise((resolve, reject) => {
      const onTimeout = () => {
        this.startedResolve = null;
        this.errorReject = null;
        this.resetStaleTimer = null;
        reject(new RasterizationError(timeoutMsg, true, "TIMEOUT"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.startedResolve = null;
        this.errorReject = null;
        this.resetStaleTimer = null;
      };
      let timer = setTimeout(onTimeout, ms);
      this.errorReject = (err) => {
        cleanup();
        reject(err);
      };
      if (resetOnProgress) {
        this.resetStaleTimer = () => {
          clearTimeout(timer);
          timer = setTimeout(onTimeout, ms);
        };
      }
      void promise.then(() => {
        cleanup();
        resolve();
      }).catch((err) => {
        this.log.debug({ error: err?.message }, "secondary rejection after settlement");
      });
    });
  }
  /** Wrap timer/rAF callbacks in try/catch so player JS errors don't kill capture. */
  async installCallbackErrorGuards() {
    await this.capturePage.installCallbackErrorGuards();
  }
  /** Resolves when all tracked stylesheet requests have a response. */
  waitForSettled() {
    return this.interceptor.waitForSettled();
  }
  /**
   * Install CDP guards that override screenshot format and gate
   * beginFrame on pending stylesheet requests. Must be called
   * after the player is loaded and before captureVideo().
   */
  prepareBrowserForCapture(screenshotFormat, screenshotQuality) {
    this.capturePage.installCDPGuards(screenshotFormat, screenshotQuality, () => this.waitForSettled(), this.log);
  }
  /** Install request interception, set up the message bridge, and navigate. */
  async load(playerConfig) {
    const page = this.capturePage.page;
    await this.interceptor.install();
    await page.exposeFunction(PLAYER_EMIT_FN, (msg) => {
      this.handleMessage(msg);
    });
    await page.evaluateOnNewDocument(
      (key, config2) => {
        ;
        window[key] = config2;
      },
      PLAYER_CONFIG_KEY,
      playerConfig
    );
    try {
      await page.goto(this.capturePage.playerUrl, { waitUntil: "load", timeout: 3e4 });
    } catch (err) {
      if (err?.name === "TimeoutError") {
        throw new RasterizationError("player page load timed out", true, "TIMEOUT", err);
      }
      throw err;
    }
    this.log.info({ origin: this.capturePage.playerUrl }, "player loaded");
  }
  /**
   * Wait for the player to finish loading and signal started.
   * Times out if no loading_progress arrives within `staleMs`.
   */
  async waitForStart(playerConfig, staleMs = 15e3) {
    const startedPromise = new Promise((resolve) => {
      this.startedResolve = resolve;
    });
    await this.awaitWithTimeout(
      startedPromise,
      staleMs,
      `Recording did not start for session ${playerConfig.sessionId} (no progress for ${staleMs / 1e3}s)`,
      true
    );
    this.log.info("loading complete");
  }
  async startPlayback() {
    const startEvent = PLAYER_START_EVENT;
    await this.capturePage.page.evaluate((evt) => {
      window.dispatchEvent(new Event(evt));
    }, startEvent);
  }
  isEnded() {
    return this.state.ended;
  }
  getError() {
    return this.playbackError;
  }
  getInactivityPeriods() {
    return this.state.inactivityPeriods;
  }
  getFrameSessionMs() {
    return this.state.frameSessionMs;
  }
  /** Read the frame timeline off the page. Works for a capture that was trimmed or timed out, where
   * the replayer never finished and so never pushed it. Falls back to whatever was pushed. */
  async readFrameTimeline() {
    try {
      const samples = await this.capturePage.page.evaluate(
        (key) => window[key] ?? [],
        PLAYER_FRAME_TIMELINE_KEY
      );
      if (samples.length > 0) {
        return samples;
      }
    } catch {
    }
    return this.state.frameSessionMs;
  }
  dispose() {
    this.startedResolve = null;
    this.errorReject = null;
    this.playbackError = null;
    this.resetStaleTimer = null;
  }
};

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/capture/recorder.ts
function estimateTotalFrames(periods, input, playbackSpeed, captureFps) {
  const skipInactivity = input.skip_inactivity !== false;
  let sessionS;
  if (skipInactivity) {
    sessionS = periods.filter((p) => p.active).reduce((sum, p) => sum + ((p.ts_to_s ?? 0) - p.ts_from_s), 0);
  } else if (periods.length > 0) {
    sessionS = periods[periods.length - 1].ts_to_s ?? 0;
  } else {
    return 0;
  }
  if (input.max_virtual_time != null) {
    sessionS = Math.min(sessionS, input.max_virtual_time);
  }
  let videoS = sessionS / playbackSpeed;
  if (input.trim != null) {
    videoS = Math.min(videoS, input.trim);
  }
  return Math.max(0, Math.ceil(videoS * captureFps));
}
async function rasterizeRecording(pool, input, outputPath, playerHtml, onProgress, options = {}) {
  const progress = options.progress ?? null;
  const cfg = options.cfg ?? config;
  const log4 = options.log ?? createLogger({ session_id: input.session_id, team_id: input.team_id });
  const signal = options.signal;
  validateInput(input);
  signal?.throwIfAborted();
  const setupStart = process.hrtime();
  const captureConfig = buildCaptureConfig(input);
  const rawPage = await pool.getPage();
  const onAbort = () => {
    log4.warn("abort requested, closing page to stop capture");
    rawPage.close().catch(() => {
    });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let player = null;
  try {
    signal?.throwIfAborted();
    const viewport = {
      width: input.viewport_width || 1280,
      height: (input.viewport_height || 720) + (input.show_metadata_footer ? METADATA_FOOTER_HEIGHT_PX : 0)
    };
    const playerUrl = `${cfg.siteUrl}/player`;
    const capturePage = await CapturePage.prepare(
      rawPage,
      viewport,
      playerUrl,
      playerHtml,
      cfg.captureBrowserLogs,
      log4
    );
    const blockProxy = options.blockSource ?? new BlockProxy(cfg, log4);
    const blockCount = await blockProxy.fetchBlocks(input);
    const compressedBytes = blockProxy.totalCompressedBytes;
    log4.info({ blockCount, compressedBytes }, "block listing fetched");
    if (!Number.isFinite(compressedBytes)) {
      log4.warn({ blockCount }, "block listing has non-numeric byte ranges; size gate skipped");
    } else if (compressedBytes > cfg.maxRecordingCompressedBytes) {
      throw new RasterizationError(
        `Recording too large to render: ${compressedBytes} compressed bytes in ${blockCount} blocks (limit ${cfg.maxRecordingCompressedBytes})`,
        false,
        "RECORDING_TOO_LARGE"
      );
    }
    const playerConfig = buildPlayerConfig(input, captureConfig.playbackSpeed, blockCount);
    player = new PlayerController(capturePage, blockProxy, onProgress, log4);
    log4.info("loading player");
    await player.load(playerConfig);
    log4.info("player loaded, waiting for recording data");
    await player.waitForStart(playerConfig);
    log4.info("recording started");
    onProgress();
    const setupS = elapsed(setupStart);
    if (progress) {
      progress.estimatedTotalFrames = estimateTotalFrames(
        player.getInactivityPeriods(),
        input,
        captureConfig.playbackSpeed,
        captureConfig.captureFps
      );
      progress.phase = "capture";
      onProgress();
      log4.info({ estimated_total_frames: progress.estimatedTotalFrames }, "estimated capture workload");
    }
    const captureResult = await capturePlayback(player, captureConfig, outputPath, onProgress, progress, log4);
    return {
      playback_speed: captureConfig.playbackSpeed,
      capture_duration_s: captureResult.capture_duration_s,
      frame_count: captureResult.frame_count,
      truncated: captureResult.truncated,
      inactivity_periods: captureResult.inactivity_periods,
      frame_session_ms: captureResult.frame_session_ms,
      pre_roll_frames: captureResult.pre_roll_frames,
      output_fps: captureConfig.outputFps,
      timings: { setup_s: setupS, capture_s: captureResult.timings.capture_s }
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    player?.dispose();
    await pool.releasePage(rawPage);
  }
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/postprocess.ts
function videoTimestampsFromFrames(periods, frameSessionMs, fps, preRollFrames = 0) {
  if (frameSessionMs.length === 0 || fps <= 0) {
    return computeVideoTimestamps(periods);
  }
  const videoTimeOf = (sample) => (preRollFrames + sample) / fps;
  const lastPeriod = periods.length - 1;
  const firstSampleS = frameSessionMs[0] / 1e3;
  const lastSampleS = frameSessionMs[frameSessionMs.length - 1] / 1e3;
  let cursor = 0;
  return periods.map((period, index) => {
    const fromMs = period.ts_from_s * 1e3;
    const toMs = period.ts_to_s != null ? period.ts_to_s * 1e3 : Number.POSITIVE_INFINITY;
    const owns = (t) => t >= fromMs && (t < toMs || index === lastPeriod && t <= toMs);
    while (cursor < frameSessionMs.length && frameSessionMs[cursor] < fromMs) {
      cursor++;
    }
    let first = -1;
    let last = -1;
    while (cursor < frameSessionMs.length && owns(frameSessionMs[cursor])) {
      if (first === -1) {
        first = cursor;
      }
      last = cursor;
      cursor++;
    }
    if (first === -1) {
      const at = videoTimeOf(cursor);
      return { ...period, recording_ts_from_s: at, recording_ts_to_s: at };
    }
    const startsMidPeriod = firstSampleS > period.ts_from_s && (period.ts_to_s == null || firstSampleS < period.ts_to_s);
    const endsMidPeriod = period.ts_to_s != null && lastSampleS < period.ts_to_s && lastSampleS >= period.ts_from_s;
    return {
      ...period,
      ts_from_s: startsMidPeriod ? firstSampleS : period.ts_from_s,
      ts_to_s: endsMidPeriod ? lastSampleS : period.ts_to_s,
      recording_ts_from_s: videoTimeOf(first),
      recording_ts_to_s: videoTimeOf(last + 1)
    };
  });
}
function computeVideoTimestamps(periods) {
  let videoTime = 0;
  const results = periods.map((period) => {
    if (period.active) {
      const recordingTsFromS = videoTime;
      const duration = period.ts_to_s != null ? period.ts_to_s - period.ts_from_s : 0;
      videoTime += duration;
      return { ...period, recording_ts_from_s: recordingTsFromS, recording_ts_to_s: videoTime };
    } else {
      return { ...period, recording_ts_from_s: videoTime, recording_ts_to_s: videoTime };
    }
  });
  for (let i = 0; i < results.length; i++) {
    if (!results[i].active) {
      continue;
    }
    for (let j = i + 1; j < results.length; j++) {
      if (results[j].active) {
        if (results[i].recording_ts_to_s > results[j].recording_ts_from_s) {
          results[i] = { ...results[i], recording_ts_to_s: results[j].recording_ts_from_s };
        }
        break;
      }
    }
  }
  return results;
}
function renderOutputFields(result, input) {
  return {
    video_duration_s: result.capture_duration_s,
    playback_speed: result.playback_speed,
    show_metadata_footer: !!input.show_metadata_footer,
    footer_height_px: input.show_metadata_footer ? METADATA_FOOTER_HEIGHT_PX : 0,
    truncated: result.truncated,
    inactivity_periods: videoTimestampsFromFrames(
      result.inactivity_periods,
      result.frame_session_ms,
      result.output_fps,
      result.pre_roll_frames
    )
  };
}

// ../posthog-mcp-trial/nodejs/src/session-replay/recording-rasterizer/rasterize-file.ts
async function rasterizeFile(pool, playerHtml, inputPath, outDir, options) {
  const input = {
    session_id: "file",
    team_id: 1,
    ...options,
    s3_bucket: "",
    s3_key_prefix: ""
  };
  const format = input.output_format || "mp4";
  await fs5.mkdir(outDir, { recursive: true });
  const videoFile = `video.${format}`;
  const log4 = createLogger({ input: inputPath });
  await fs5.rm(path.join(outDir, "rasterize.json"), { force: true });
  const result = await rasterizeRecording(pool, input, path.join(outDir, videoFile), playerHtml, () => {
  }, {
    log: log4,
    blockSource: new FileBlockSource(inputPath, config.maxSourceDecompressedBytes)
  });
  const stat4 = await fs5.stat(path.join(outDir, videoFile));
  const output = {
    video_file: videoFile,
    ...renderOutputFields(result, input),
    file_size_bytes: stat4.size,
    timings: { ...result.timings, upload_s: 0, total_s: result.timings.setup_s + result.timings.capture_s }
  };
  await fs5.writeFile(path.join(outDir, "rasterize.json"), JSON.stringify(output, null, 2));
  return output;
}
async function main() {
  const { values } = (0, import_util2.parseArgs)({
    options: {
      input: { type: "string" },
      out: { type: "string" },
      options: { type: "string", default: "{}" }
    }
  });
  if (!values.input || !values.out) {
    throw new Error("usage: rasterize-file --input <events.jsonl[.zst]> --out <dir> [--options <json>]");
  }
  const pool = new BrowserPool();
  await pool.launch();
  try {
    const playerHtml = await playerHtmlCache.load();
    const output = await rasterizeFile(pool, playerHtml, values.input, values.out, parseJSON(values.options));
    process.stdout.write(JSON.stringify(output) + "\n");
  } finally {
    await pool.shutdown();
  }
}
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}
`);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BrowserPool,
  rasterizeFile
});
