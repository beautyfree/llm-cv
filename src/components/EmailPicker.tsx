import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";

interface Props {
  /** Map of email → number of repos it appears in */
  emailCounts: Map<string, number>;
  /** Emails that are pre-selected (from git config) */
  preSelected: Set<string>;
  onSubmit: (selected: string[], save: boolean) => void;
}

/**
 * Interactive email picker. Shows all emails found across repos,
 * pre-selects ones from git config, lets user toggle the rest.
 * After selection, asks whether to save to config.
 */
export function EmailPicker({ emailCounts, preSelected, onSubmit }: Props) {
  const { exit } = useApp();

  // Sort: pre-selected first, then by repo count descending
  const emails = [...emailCounts.entries()]
    .sort(([aEmail, aCount], [bEmail, bCount]) => {
      const aSelected = preSelected.has(aEmail) ? 1 : 0;
      const bSelected = preSelected.has(bEmail) ? 1 : 0;
      if (aSelected !== bSelected) return bSelected - aSelected;
      return bCount - aCount;
    })
    .map(([email, count]) => ({ email, count }));

  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set(preSelected));
  const [phase, setPhase] = useState<"pick" | "save">("pick");

  // Windowed scrolling
  const windowSize = Math.min(15, emails.length);
  const halfWindow = Math.floor(windowSize / 2);
  let start = Math.max(0, cursor - halfWindow);
  const end = Math.min(emails.length, start + windowSize);
  if (end === emails.length) start = Math.max(0, end - windowSize);
  const visible = emails.slice(start, end);

  useInput((input, key) => {
    if (phase === "save") {
      if (input === "y" || key.return) {
        onSubmit([...selected], true);
      } else if (input === "n") {
        onSubmit([...selected], false);
      }
      return;
    }

    if (key.upArrow) {
      setCursor((c) => (c > 0 ? c - 1 : emails.length - 1));
    } else if (key.downArrow) {
      setCursor((c) => (c < emails.length - 1 ? c + 1 : 0));
    } else if (input === " ") {
      const email = emails[cursor]?.email;
      if (!email) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(email)) next.delete(email);
        else next.add(email);
        return next;
      });
    } else if (key.return) {
      if (selected.size === 0) return; // don't allow empty
      setPhase("save");
    } else if (input === "q" || key.escape) {
      exit();
    }
  });

  if (phase === "save") {
    return (
      <Box flexDirection="column">
        <Text bold>Selected {selected.size} email(s):</Text>
        {[...selected].map((e) => (
          <Text key={e} color="green">  {e}</Text>
        ))}
        <Text> </Text>
        <Text>Save as your default emails? <Text bold>(Y/n)</Text></Text>
        <Text dimColor>Next time you won't be asked. Use --email to override for one-time runs.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text bold>
          Which of these emails are yours? ({selected.size} selected)
        </Text>
        <Text dimColor>
          [Space] toggle  [Enter] confirm  [q] quit
        </Text>
        <Text color="yellow">
          TIP: Select ALL emails you've ever used for git commits,
          including work, personal, and old addresses.
          Your previous selection is pre-checked. Just hit Enter if correct.
        </Text>
      </Box>

      {visible.map(({ email, count }, i) => {
        const globalIndex = start + i;
        const isCursor = globalIndex === cursor;
        const isSelected = selected.has(email);
        const isFromConfig = preSelected.has(email);
        const checkbox = isSelected ? "[x]" : "[ ]";

        return (
          <Box key={email} gap={1}>
            <Text
              color={isCursor ? "cyan" : undefined}
              inverse={isCursor}
            >
              {checkbox} {email}
            </Text>
            <Text dimColor>
              {count} repo{count !== 1 ? "s" : ""}
            </Text>
            {isFromConfig && (
              <Text color="green">(git config)</Text>
            )}
          </Box>
        );
      })}

      {emails.length > windowSize && (
        <Text dimColor>
          {"\n"}{start + 1}-{end} of {emails.length}
        </Text>
      )}
    </Box>
  );
}
