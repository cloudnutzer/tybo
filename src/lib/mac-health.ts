/**
 * Mac Health Monitor
 *
 * When running in hybrid mode, the VPS checks if the Mac (local machine)
 * is alive and responsive. If Mac is alive, messages are forwarded to it
 * (uses Claude Code CLI with subscription). If Mac is down, VPS processes
 * using Anthropic API (pay-per-token).
 *
 * Health check methods:
 * 1. HTTP GET to your Mac's health endpoint (via Cloudflare Tunnel or similar)
 * 2. Fallback: Supabase node_heartbeat table
 *
 * Uses cached status -- doesn't check per-message.
 * 2 consecutive failures = DOWN, 1 success = ALIVE.
 */

import { getNodeStatus } from "./convex";

interface HealthState {
  isAlive: boolean;
  lastCheck: number;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

const state: HealthState = {
  isAlive: false, // Start pessimistic -- VPS should process until Mac proves alive
  lastCheck: 0,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
};

const CHECK_INTERVAL_MS = 30_000; // Check every 30s
const HEALTH_TIMEOUT_MS = 5_000; // 5s timeout for health check
const FAILURES_UNTIL_DOWN = 2; // 2 consecutive failures = DOWN

/**
 * Perform a single health check against Mac
 */
async function checkMacHealth(): Promise<boolean> {
  const healthUrl = process.env.MAC_HEALTH_URL;

  // Method 1: HTTP check (via Cloudflare Tunnel, ngrok, etc.)
  if (healthUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      const res = await fetch(healthUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as Record<string, any>;
        return data.status === "ok";
      }
    } catch {
      // HTTP check failed, try Supabase fallback
    }
  }

  // Method 2: Supabase heartbeat (Mac writes heartbeats, VPS reads them)
  try {
    const macStatus = await getNodeStatus("mac", 90_000);
    return macStatus.online;
  } catch {
    return false;
  }
}

/**
 * Update cached health state
 */
async function updateHealth(): Promise<void> {
  const alive = await checkMacHealth();

  if (alive) {
    state.isAlive = true;
    state.consecutiveFailures = 0;
    state.lastSuccessAt = Date.now();
  } else {
    state.consecutiveFailures++;
    state.lastFailureAt = Date.now();

    if (state.consecutiveFailures >= FAILURES_UNTIL_DOWN) {
      if (state.isAlive) {
        console.log(
          `Mac went DOWN after ${state.consecutiveFailures} failures`
        );
      }
      state.isAlive = false;
    }
  }

  state.lastCheck = Date.now();
}

/**
 * Check if Mac is alive (cached, updated in background)
 */
export function isMacAlive(): boolean {
  return state.isAlive;
}

/**
 * Get full health state for debugging
 */
export function getHealthState(): HealthState {
  return { ...state };
}

/**
 * Start the background health check loop
 */
export function startHealthMonitor(): void {
  const healthUrl = process.env.MAC_HEALTH_URL || "(Supabase heartbeat only)";
  console.log(
    `Mac health monitor started (checking ${healthUrl} every ${CHECK_INTERVAL_MS / 1000}s)`
  );

  // Initial check
  updateHealth().catch((err) =>
    console.error("Initial health check error:", err)
  );

  // Periodic check
  setInterval(() => {
    updateHealth().catch((err) =>
      console.error("Health check error:", err)
    );
  }, CHECK_INTERVAL_MS);
}

/**
 * Force an immediate health check (for testing)
 */
export async function forceCheck(): Promise<boolean> {
  await updateHealth();
  return state.isAlive;
}

// Updated February 2026: Clarified deployment modes and authentication following Anthropic's January 2026 ToS enforcement.
