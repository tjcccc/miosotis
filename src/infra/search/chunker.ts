import { splitsSurrogatePair } from "../../domain/text.js";

export interface ChunkSpan {
  ordinal: number;
  start: number;
  end: number;
}

export const CHUNK_TARGET = 1500;

/**
 * Splits text into contiguous, non-overlapping spans at paragraph boundaries (UTF-16 offsets).
 * Short texts stay whole. Oversized paragraphs are cut at a line/sentence/space boundary when
 * one exists near the limit, and never inside a surrogate pair.
 */
export function chunkText(text: string, target: number = CHUNK_TARGET): ChunkSpan[] {
  if (text.length === 0) {
    return [];
  }
  const spans: ChunkSpan[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + target, text.length);
    if (end < text.length) {
      end = findBreak(text, start, end);
    }
    if (splitsSurrogatePair(text, end)) {
      end -= 1;
    }
    if (end <= start) {
      end = Math.min(start + target, text.length);
      if (splitsSurrogatePair(text, end)) {
        end += 1;
      }
    }
    spans.push({ ordinal: spans.length, start, end });
    start = end;
  }
  return spans;
}

function findBreak(text: string, start: number, limit: number): number {
  const window = text.slice(start, limit);
  const minimum = Math.floor(window.length / 2);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= minimum) {
    return start + paragraph + 2;
  }
  const line = window.lastIndexOf("\n");
  if (line >= minimum) {
    return start + line + 1;
  }
  const sentence = lastSentenceEnd(window);
  if (sentence >= minimum) {
    return start + sentence;
  }
  const space = window.lastIndexOf(" ");
  if (space >= minimum) {
    return start + space + 1;
  }
  return limit;
}

const SENTENCE_END = /[.!?。！？؟।]\s*/gu;

function lastSentenceEnd(window: string): number {
  let last = -1;
  for (const match of window.matchAll(SENTENCE_END)) {
    last = match.index + match[0].length;
  }
  return last;
}
