/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import fs from "fs/promises";
import path from "path";
import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type {
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIToolCall,
  OpenAIResponseContentBlock,
} from "../types/openai.js";

export interface CollectedImage {
  data: string;
  media_type: string;
}

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  toolCalls?: OpenAIToolCall[]
): OpenAIChatResponse {
  // Get model from modelUsage or default
  const modelName = result.modelUsage
    ? Object.keys(result.modelUsage)[0]
    : "claude-sonnet-4";

  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: result.result,
  };

  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens:
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}

/**
 * Build response content with images in OpenAI content block format.
 * Returns plain string if no images, or content block array with text + image_url blocks.
 */
export function buildContentWithImages(
  text: string,
  images: CollectedImage[]
): string | OpenAIResponseContentBlock[] {
  if (images.length === 0) return text;

  const blocks: OpenAIResponseContentBlock[] = [];
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const img of images) {
    blocks.push({
      type: "image_url",
      image_url: { url: `data:${img.media_type};base64,${img.data}` },
    });
  }
  return blocks;
}

const IMAGE_PATH_PATTERN = /(?:^|\s)(\/[\w/._ -]+\.(?:png|jpg|jpeg|gif|webp|svg))\b/gi;

const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * Extract generated image files referenced in the result text.
 * Reads files from disk and returns them as base64-encoded images.
 */
export async function extractGeneratedImages(
  text: string
): Promise<CollectedImage[]> {
  const images: CollectedImage[] = [];
  for (const match of text.matchAll(IMAGE_PATH_PATTERN)) {
    const filePath = match[1];
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      images.push({
        data: data.toString("base64"),
        media_type: MIME_MAP[ext] || "image/png",
      });
    } catch {
      // File doesn't exist or isn't readable — skip
    }
  }
  return images;
}

/**
 * Normalize Claude model names to a consistent format
 * e.g., "claude-sonnet-4-5-20250929" -> "claude-sonnet-4"
 */
function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-4";
  if (model.includes("opus")) return "claude-opus-4";
  if (model.includes("sonnet")) return "claude-sonnet-4";
  if (model.includes("haiku")) return "claude-haiku-4";
  return model;
}
