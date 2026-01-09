/**
 * PanelGroup - Distributes vertical space among multiple panels
 *
 * Uses a priority-based algorithm to allocate space:
 * 1. Each panel gets its minimum height first
 * 2. Remaining space is distributed by priority (higher = first)
 * 3. Panels respect their maxHeight limits
 */
import React from 'react';
import { Box } from 'ink';

export interface PanelConfig {
  /** Unique identifier for the panel */
  id: string;
  /** Minimum height the panel needs */
  minHeight: number;
  /** Maximum height the panel can use (optional, defaults to unlimited) */
  maxHeight?: number;
  /** Priority for receiving extra space (higher = gets space first) */
  priority: number;
  /** The panel content to render */
  content: React.ReactNode;
}

interface PanelGroupProps {
  /** Total height available for all panels */
  availableHeight: number;
  /** Panel configurations */
  panels: PanelConfig[];
}

/**
 * Distributes available space among panels based on priority
 *
 * Algorithm:
 * 1. Give each panel its minimum height
 * 2. Sort panels by priority (descending)
 * 3. Distribute remaining space to highest priority panels first
 * 4. Respect maxHeight limits
 */
function distributeSpace(
  panels: PanelConfig[],
  available: number
): Map<string, number> {
  const heights = new Map<string, number>();
  let remaining = available;

  // Step 1: Give each panel its minimum height
  for (const panel of panels) {
    heights.set(panel.id, panel.minHeight);
    remaining -= panel.minHeight;
  }

  // Step 2: Distribute remaining space by priority
  if (remaining > 0) {
    const sorted = [...panels].sort((a, b) => b.priority - a.priority);
    for (const panel of sorted) {
      if (remaining <= 0) break;
      const current = heights.get(panel.id)!;
      const max = panel.maxHeight ?? Infinity;
      const canAdd = Math.min(remaining, max - current);
      if (canAdd > 0) {
        heights.set(panel.id, current + canAdd);
        remaining -= canAdd;
      }
    }
  }

  return heights;
}

/**
 * PanelGroup component that manages vertical space distribution
 *
 * Takes an array of panel configurations and renders them with
 * calculated heights based on available space and priority.
 */
export function PanelGroup({ availableHeight, panels }: PanelGroupProps) {
  // Calculate heights for each panel
  const heights = distributeSpace(panels, availableHeight);

  return (
    <Box flexDirection="column" height={availableHeight} overflow="hidden">
      {panels.map((panel) => {
        const panelHeight = heights.get(panel.id) ?? panel.minHeight;
        return (
          <Box
            key={panel.id}
            flexDirection="column"
            height={panelHeight}
            overflow="hidden"
          >
            {panel.content}
          </Box>
        );
      })}
    </Box>
  );
}
