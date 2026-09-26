/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as assets from "../assets.js";
import type * as asyncTasks from "../asyncTasks.js";
import type * as callTranscripts from "../callTranscripts.js";
import type * as embeddingPatches from "../embeddingPatches.js";
import type * as embeddings from "../embeddings.js";
import type * as http from "../http.js";
import type * as knowledge from "../knowledge.js";
import type * as logs from "../logs.js";
import type * as memory from "../memory.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as nodeHeartbeat from "../nodeHeartbeat.js";
import type * as scheduledTasks from "../scheduledTasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  assets: typeof assets;
  asyncTasks: typeof asyncTasks;
  callTranscripts: typeof callTranscripts;
  embeddingPatches: typeof embeddingPatches;
  embeddings: typeof embeddings;
  http: typeof http;
  knowledge: typeof knowledge;
  logs: typeof logs;
  memory: typeof memory;
  messages: typeof messages;
  migrations: typeof migrations;
  nodeHeartbeat: typeof nodeHeartbeat;
  scheduledTasks: typeof scheduledTasks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
