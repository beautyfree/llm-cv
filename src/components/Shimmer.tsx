import React, { useState, useEffect } from "react";
import { Text } from "ink";

const RAINBOW = [
  "#FF6B6B", "#FF8E53", "#FFC107", "#4CAF50", "#2196F3", "#9C27B0", "#FF6B6B",
];

interface Props {
  children: string;
}

/**
 * Rainbow shimmer text — cycles gradient colors across characters.
 * Used for the "agent-cv" brand and active process verbs.
 */
export function Shimmer({ children }: Props) {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setOffset((o) => o + 1), 150);
    return () => clearInterval(timer);
  }, []);

  const chars = [...children];

  return (
    <Text>
      {chars.map((char, i) => {
        const colorIndex = (i + offset) % (RAINBOW.length - 1);
        return (
          <Text key={i} color={RAINBOW[colorIndex]}>
            {char}
          </Text>
        );
      })}
    </Text>
  );
}
