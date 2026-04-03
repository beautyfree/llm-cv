import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { ClaudeAdapter } from "../lib/analysis/claude-adapter.ts";
import { CodexAdapter } from "../lib/analysis/codex-adapter.ts";
import { CursorAdapter } from "../lib/analysis/cursor-adapter.ts";
import { APIAdapter } from "../lib/analysis/api-adapter.ts";
import type { AgentAdapter } from "../lib/types.ts";

interface AgentOption {
  name: string;
  label: string;
  adapter: AgentAdapter;
  available: boolean;
  detail: string;
}

interface Props {
  onSubmit: (adapter: AgentAdapter, name: string) => void;
}

export function AgentPicker({ onSubmit }: Props) {
  const { exit } = useApp();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function detect() {
      const options: AgentOption[] = [
        {
          name: "claude",
          label: "Claude Code",
          adapter: new ClaudeAdapter(),
          available: false,
          detail: "reads files directly, best analysis quality",
        },
        {
          name: "codex",
          label: "Codex CLI",
          adapter: new CodexAdapter(),
          available: false,
          detail: "OpenAI codex agent",
        },
        {
          name: "cursor",
          label: "Cursor Agent",
          adapter: new CursorAdapter(),
          available: false,
          detail: "headless mode, runs in project directory",
        },
        {
          name: "api",
          label: "API (OpenRouter / Anthropic / OpenAI / Ollama)",
          adapter: new APIAdapter(),
          available: false,
          detail: "uses API key from environment",
        },
      ];

      // Check availability in parallel
      await Promise.all(
        options.map(async (opt) => {
          opt.available = await opt.adapter.isAvailable();
        })
      );

      setAgents(options);
      // Pre-select first available
      const firstAvailable = options.findIndex((o) => o.available);
      if (firstAvailable >= 0) setCursor(firstAvailable);
      setLoading(false);
    }
    detect();
  }, []);

  useInput((input, key) => {
    if (loading) return;

    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : agents.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < agents.length - 1 ? c + 1 : 0));
    } else if (key.return) {
      const selected = agents[cursor];
      if (selected?.available) {
        onSubmit(selected.adapter, selected.name);
      }
    } else if (input === "q" || key.escape) {
      exit();
    }
  });

  if (loading) {
    return <Text color="yellow">Detecting available AI agents...</Text>;
  }

  const anyAvailable = agents.some((a) => a.available);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text bold>Choose AI agent for analysis</Text>
        <Text dimColor>[Enter] select  [q] quit</Text>
      </Box>

      {agents.map((agent, i) => {
        const isCursor = i === cursor;
        const radio = isCursor ? "◉" : "○";

        if (!agent.available) {
          return (
            <Box key={agent.name} gap={1}>
              <Text color="gray">
                {radio} {agent.label}
              </Text>
              <Text color="gray">— not found</Text>
            </Box>
          );
        }

        return (
          <Box key={agent.name} gap={1}>
            <Text color={isCursor ? "cyan" : undefined} bold={isCursor}>
              {radio} {agent.label}
            </Text>
            <Text dimColor>{agent.detail}</Text>
          </Box>
        );
      })}

      {!anyAvailable && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">No AI agents found.</Text>
          <Text dimColor>
            Install Claude Code, Codex, Cursor, or set an API key.
          </Text>
        </Box>
      )}
    </Box>
  );
}
