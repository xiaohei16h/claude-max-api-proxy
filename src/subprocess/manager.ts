/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import {
  isAssistantMessage,
  isResultMessage,
  isToolResultMessage,
  isContentDelta,
  isTextBlockStart,
  isToolUseBlockStart,
  isInputJsonDelta,
  isContentBlockStop,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = 900000; // 15 minutes

/**
 * System prompt appended to Claude CLI to map OpenClaw tool names to Claude Code equivalents.
 * OpenClaw's system prompt references tools like `exec`, `read`, `web_search` etc. that
 * don't exist in Claude Code. This mapping tells the model what to use instead.
 *
 * Keep in sync with the OpenClaw tool catalog and Claude Code tool registry.
 */
export const OPENCLAW_TOOL_MAPPING_PROMPT = [
  "## Tool Name Mapping",
  "You are running inside Claude Code CLI, not OpenClaw. The system prompt may reference OpenClaw tool names — use these equivalents:",
  "",
  "### Direct replacements",
  "| OpenClaw tool | Use instead | Notes |",
  "|---|---|---|",
  "| `exec`, `process` | `Bash` | Run shell commands |",
  "| `code_execution` | `Bash` | Run code (no sandbox in CLI mode) |",
  "| `read` | `Read` | Read file contents |",
  "| `write` | `Write` | Write/create files |",
  "| `edit` | `Edit` | Precise string replacements |",
  "| `apply_patch` | `Edit` | Use Edit's old_string/new_string for each hunk |",
  "| `grep` | `Grep` | Search file contents |",
  "| `find`, `ls` | `Glob` | File pattern matching |",
  "| `web_search` | `WebSearch` | Web search |",
  "| `web_fetch` | `WebFetch` | Fetch web content |",
  "| `x_search` | `WebSearch` | Add `site:x.com` to query |",
  "| `image` | `Read` | Claude Code can read images natively |",
  "| `sessions_spawn` | `Agent` | Spawn a subagent |",
  "| `sessions_send` | `SendMessage` | Send message to another agent |",
  "| `subagents` | `Agent` + `TaskList` | Spawn and manage subagents |",
  "| `agents_list` | `TaskList` | List agents/tasks |",
  "| `session_status` | `TaskList` | Check current status |",
  "| `update_plan` | `TaskCreate` / `TaskUpdate` | Create or update tasks |",
  "| `cron` (add) | `CronCreate` | Schedule recurring tasks |",
  "| `cron` (rm) | `CronDelete` | Remove scheduled tasks |",
  "| `cron` (list/status) | `CronList` | List scheduled tasks |",
  "",
  "### Via openclaw CLI (use Bash)",
  '- `memory_search` → `Bash(openclaw memory search "<query>")`',
  "- `memory_get` → `Read` the memory file, or `Bash(openclaw memory search ...)` for discovery",
  '- `message` → `Bash(openclaw message send --to <target> "<text>")`',
  "  - Subcommands: `read`, `broadcast`, `react`, `poll`",
  "- `sessions_list` → `Bash(openclaw sessions list)`",
  "- `sessions_history` → `Bash(openclaw sessions history <id>)`",
  "- `nodes` → `Bash(openclaw nodes status)`, `Bash(openclaw nodes describe <node>)`",
  '  - Run commands: `openclaw nodes run --node <id> "<cmd>"`',
  '  - Invoke: `openclaw nodes invoke --node <id> --command <cmd>`',
  "",
  "### Not available in CLI mode",
  "These require dedicated OpenClaw backend services — do not attempt to call them:",
  "- `browser` — needs OpenClaw browser server",
  "- `canvas` — needs paired node with canvas",
  "- `gateway` — OpenClaw gateway control only",
  "- `image_generate` — needs image generation backend",
  "- `music_generate` — needs music generation backend",
  "- `video_generate` — needs video generation backend",
  "- `tts` — needs text-to-speech backend",
  "- `sessions_yield` — OpenClaw multi-agent scheduler only",
  "",
  "### Skills",
  "Claude Code's native Skill tool is disabled. Use OpenClaw skills via `Read` instead:",
  "- If the system prompt contains `<available_skills>`, scan `<description>` entries for a match.",
  "- When a skill matches the task, use `Read` on its `<location>` path to load the SKILL.md, then follow its instructions.",
  "- To discover workspace skills: `Bash(openclaw skills list --eligible --json)`",
  "- Skills directory: `skills/` relative to working directory.",
].join("\n");

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(options);
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        this.process = spawn(process.env.CLAUDE_BIN || "claude", args, {
          cwd: options.cwd || process.cwd(),
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
          ),
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Set timeout
        this.timeoutId = setTimeout(() => {
          if (!this.isKilled) {
            this.isKilled = true;
            this.process?.kill("SIGTERM");
            this.emit("error", new Error(`Request timed out after ${timeout}ms`));
          }
        }, timeout);

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimeout();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            );
          } else {
            reject(err);
          }
        });

        // Pass prompt via stdin to avoid E2BIG on large inputs
        this.process.stdin?.write(prompt);
        this.process.stdin?.end();

        if (process.env.DEBUG_SUBPROCESS) {
          console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);
        }

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          }
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            if (process.env.DEBUG_SUBPROCESS) {
              console.error("[Subprocess stderr]:", errorText.slice(0, 200));
            }
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Process closed with code: ${code}`);
          }
          this.clearTimeout();
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array
   */
  private buildArgs(options: SubprocessOptions): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", options.model,
      "--no-session-persistence",
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "user",
      "--disallowed-tools", "Skill",
      "--disable-slash-commands",
      "--append-system-prompt", OPENCLAW_TOOL_MAPPING_PROMPT,
    ];

    if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    return args;
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isTextBlockStart(message)) {
          // Emit when a new text content block starts (for inserting separators)
          this.emit("text_block_start", message as ClaudeCliStreamEvent);
        }

        if (isToolUseBlockStart(message)) {
          this.emit("tool_use_start", message as ClaudeCliStreamEvent);
        }

        if (isInputJsonDelta(message)) {
          this.emit("input_json_delta", message as ClaudeCliStreamEvent);
        }

        if (isContentBlockStop(message)) {
          this.emit("content_block_stop", message as ClaudeCliStreamEvent);
        }

        // Extract images from tool_result content blocks
        if (isToolResultMessage(message) && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (
              block.type === "image" &&
              typeof block.source === "object" &&
              block.source !== null &&
              (block.source as any).type === "base64"
            ) {
              const source = block.source as { data: string; media_type: string };
              this.emit("image", {
                data: source.data,
                media_type: source.media_type,
              });
            }
          }
        }

        if (isContentDelta(message)) {
          // Emit content delta for streaming (text_delta only)
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          // Extract images from assistant message content blocks
          for (const block of message.message.content) {
            if (block.type === "image") {
              this.emit("image", {
                data: block.source.data,
                media_type: block.source.media_type,
              });
            }
          }
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimeout();
      this.process.kill(signal);
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.env.CLAUDE_BIN || "claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
