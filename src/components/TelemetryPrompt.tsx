import React from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  onChoice: (enabled: boolean) => void;
}

export function TelemetryPrompt({ onChoice }: Props) {
  useInput((input) => {
    if (input === "y") onChoice(true);
    else if (input === "n") onChoice(false);
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Help improve agent-cv?</Text>
      <Text dimColor>Anonymous usage data: which commands run, project count, agent type.</Text>
      <Text dimColor>No file paths, names, emails, or project content. Ever.</Text>
      <Text dimColor>Disable anytime: agent-cv config or AGENT_CV_TELEMETRY=off</Text>
      <Text> </Text>
      <Text>Enable anonymous telemetry? <Text color="green" bold>(y)</Text> / <Text color="red">n</Text></Text>
    </Box>
  );
}
