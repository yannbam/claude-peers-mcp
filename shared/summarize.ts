import { execFileText } from "./subprocess.ts";

/** Context passed to the auto-summary model for a single Claude session. */
export interface SummaryContext {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
}

/** Minimal shape needed from the Chat Completions response body. */
interface OpenAIChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

/** Model used for cheap, best-effort startup summaries. */
const SUMMARY_MODEL = "gpt-5.4-nano";

/** Timeout budget for the auto-summary network request. */
const SUMMARY_TIMEOUT_MS = 5_000;

/** Split command output into trimmed, non-empty lines. */
function splitNonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Generate a short summary of what a Claude Code instance is likely working on.
 *
 * Returns `null` when no API key is available or when the network call fails.
 */
export async function generateSummary(context: SummaryContext): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  // Keep the prompt grounded in local context that exists before Claude starts working.
  const parts = [`Working directory: ${context.cwd}`];
  if (context.git_root) {
    parts.push(`Git repo root: ${context.git_root}`);
  }
  if (context.git_branch) {
    parts.push(`Branch: ${context.git_branch}`);
  }
  if (context.recent_files && context.recent_files.length > 0) {
    parts.push(`Recently modified files: ${context.recent_files.join(", ")}`);
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You generate brief summaries of what a developer is working on based on their project context. Respond with exactly 1-2 sentences, no more. Be specific about the project name and likely task.",
          },
          {
            role: "user",
            content: `Based on this context, what is this developer likely working on?\n\n${parts.join("\n")}`,
          },
        ],
        max_tokens: 100,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as OpenAIChatCompletionResponse;
    return data.choices[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Get the current git branch for a directory, or `null` outside a git repo. */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const result = await execFileText("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeoutMs: 3_000,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Get recently modified tracked files for a git worktree. */
export async function getRecentFiles(cwd: string, limit = 10): Promise<string[]> {
  try {
    // Prefer local changes first so summaries reflect the user's live work.
    const diffResult = await execFileText("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      timeoutMs: 3_000,
    });
    const modifiedFiles = splitNonEmptyLines(diffResult.stdout);

    if (modifiedFiles.length >= limit) {
      return modifiedFiles.slice(0, limit);
    }

    // Fill the remaining context from recent commits when the worktree is mostly clean.
    const logResult = await execFileText(
      "git",
      ["log", "--oneline", "--name-only", "-5", "--format="],
      {
        cwd,
        timeoutMs: 3_000,
      }
    );
    const recentCommittedFiles = splitNonEmptyLines(logResult.stdout);

    return [...new Set([...modifiedFiles, ...recentCommittedFiles])].slice(0, limit);
  } catch {
    return [];
  }
}
