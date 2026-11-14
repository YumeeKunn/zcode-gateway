import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// OpenAI Chat Completions  ->  Anthropic Messages
// ---------------------------------------------------------------------------

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function openAIContentToAnthropicBlocks(content) {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url !== "string") continue;
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (match) {
        blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
      } else {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return blocks;
}

function mapToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto") return { type: "auto" };
    if (choice === "required") return { type: "any" };
    if (choice === "none") return undefined;
    return undefined;
  }
  if (typeof choice === "object" && choice.type === "function" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

export function openAIToAnthropic(body, fallbackModel) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemParts = [];
  const converted = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;

    if (role === "system" || role === "developer") {
      const text = textOfContent(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? message.name ?? "",
        content: textOfContent(message.content),
      };
      const previous = converted[converted.length - 1];
      if (previous && previous.role === "user" && Array.isArray(previous.content)) {
        previous.content.push(block);
      } else {
        converted.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (role === "assistant") {
      const blocks = [];
      const text = textOfContent(message.content);
      if (text) blocks.push({ type: "text", text });
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call?.function?.name) continue;
          let input = {};
          const rawArgs = call.function.arguments;
          if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
            try {
              input = JSON.parse(rawArgs);
            } catch {
              input = {};
            }
          } else if (rawArgs && typeof rawArgs === "object") {
            input = rawArgs;
          }
          blocks.push({ type: "tool_use", id: call.id ?? `toolu_${randomUUID()}`, name: call.function.name, input });
        }
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      converted.push({ role: "assistant", content: blocks });
      continue;
    }

    const blocks = openAIContentToAnthropicBlocks(message.content);
    if (blocks.length === 0) continue;
    converted.push({ role: "user", content: blocks });
  }

  const tools = Array.isArray(body?.tools)
    ? body.tools
        .filter((tool) => tool && (tool.type === undefined || tool.type === "function") && tool.function?.name)
        .map((tool) => ({
          name: tool.function.name,
          description: tool.function.description ?? "",
          input_schema: tool.function.parameters ?? { type: "object", properties: {} },
        }))
    : undefined;

  const budget = body?.max_completion_tokens ?? body?.max_tokens;
  const result = {
    model: typeof body?.model === "string" && body.model.trim() ? body.model.trim() : fallbackModel,
    max_tokens: Number.isFinite(budget) && budget > 0 ? budget : 8192,
    messages: converted,
  };

  if (systemParts.length > 0) result.system = systemParts.join("\n\n");
  if (tools && tools.length > 0) {
    result.tools = tools;
    const choice = mapToolChoice(body.tool_choice);
    if (choice) result.tool_choice = choice;
  }
  if (Number.isFinite(body?.temperature)) result.temperature = body.temperature;
  if (Number.isFinite(body?.top_p)) result.top_p = body.top_p;
  if (Number.isFinite(body?.top_k)) result.top_k = body.top_k;
  if (Array.isArray(body?.stop) && body.stop.length > 0) result.stop_sequences = body.stop.filter((s) => typeof s === "string");
  else if (typeof body?.stop === "string" && body.stop) result.stop_sequences = [body.stop];
  if (body?.stream === true) result.stream = true;

  return result;
}

// ---------------------------------------------------------------------------
// Anthropic Messages  ->  OpenAI Chat Completions
// ---------------------------------------------------------------------------

function mapStopReason(reason) {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "stop_sequence":
    case "end_turn":
      return "stop";
    default:
      return reason ? "stop" : null;
  }
}

export function anthropicToOpenAI(response, requestedModel) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if ((block.type === "thinking" || block.type === "reasoning") && typeof block.thinking === "string") reasoning += block.thinking;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? `call_${randomUUID()}`,
        type: "function",
        function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message = { role: "assistant", content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = response?.usage ?? {};
  return {
    id: response?.id ?? `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel ?? response?.model ?? "glm",
    choices: [{ index: 0, message, finish_reason: mapStopReason(response?.stop_reason) }],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** Parse an SSE byte stream into `{event, data}` records. */
export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = "";
      const dataLines = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
      index = buffer.indexOf("\n\n");
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    let event = "";
    const dataLines = [];
    for (const line of tail.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
  }
}

/**
 * Translate an Anthropic SSE stream into OpenAI chat.completion.chunk frames.
 * Yields already-serialized `data: {...}\n\n` strings (plus the final [DONE]).
 */
export async function* anthropicSseToOpenAiSse(body, requestedModel) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = requestedModel ?? "glm";
  let sentRole = false;
  let toolIndex = -1;
  let sawTool = false;
  let finishReason = null;
  let promptTokens = 0;
  let completionTokens = 0;

  const frame = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  for await (const { event, data } of parseSse(body)) {
    if (data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const type = payload?.type ?? event;

    if (type === "message_start") {
      promptTokens = payload?.message?.usage?.input_tokens ?? promptTokens;
      if (!sentRole) {
        sentRole = true;
        yield frame({ role: "assistant", content: "" });
      }
      continue;
    }

    if (type === "content_block_start") {
      const block = payload?.content_block;
      if (block?.type === "tool_use") {
        toolIndex += 1;
        sawTool = true;
        if (!sentRole) {
          sentRole = true;
          yield frame({ role: "assistant", content: "" });
        }
        yield frame({
          tool_calls: [
            {
              index: toolIndex,
              id: block.id ?? `call_${randomUUID()}`,
              type: "function",
              function: { name: block.name ?? "", arguments: "" },
            },
          ],
        });
      } else if (block?.type === "thinking" && !sentRole) {
        sentRole = true;
        yield frame({ role: "assistant", content: "" });
      }
      continue;
    }

    if (type === "content_block_delta") {
      const delta = payload?.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        if (!sentRole) {
          sentRole = true;
          yield frame({ role: "assistant", content: "" });
        }
        yield frame({ content: delta.text });
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
        if (!sentRole) {
          sentRole = true;
          yield frame({ role: "assistant", content: "" });
        }
        yield frame({ reasoning_content: delta.thinking });
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) {
        yield frame({ tool_calls: [{ index: Math.max(0, toolIndex), function: { arguments: delta.partial_json } }] });
      }
      continue;
    }

    if (type === "message_delta") {
      const reason = payload?.delta?.stop_reason;
      if (reason) finishReason = mapStopReason(reason);
      completionTokens = payload?.usage?.output_tokens ?? completionTokens;
      continue;
    }

    if (type === "error") {
      const message = payload?.error?.message ?? "upstream stream error";
      yield `data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`;
      continue;
    }
  }

  if (!sentRole) yield frame({ role: "assistant", content: "" });
  if (finishReason === null) finishReason = sawTool ? "tool_calls" : "stop";

  yield frame({}, finishReason);
  yield `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  })}\n\n`;
  yield "data: [DONE]\n\n";
}
