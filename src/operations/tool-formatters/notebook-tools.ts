/**
 * Notebook tool formatter
 *
 * Handles formatting of Jupyter notebook tools:
 * - NotebookEdit: Edit cells in Jupyter notebooks
 */

import type { ToolFormatter, ToolFormatResult, ToolInput, ToolFormatOptions } from './types.js';
import { shortenPath } from './utils.js';

// ---------------------------------------------------------------------------
// Notebook Tools Formatter
// ---------------------------------------------------------------------------

/**
 * Formatter for Jupyter notebook tools (NotebookEdit).
 */
export const notebookToolsFormatter: ToolFormatter = {
  toolNames: ['NotebookEdit'],

  format(toolName: string, input: ToolInput, options: ToolFormatOptions): ToolFormatResult | null {
    if (toolName !== 'NotebookEdit') return null;

    const { formatter, worktreeInfo } = options;

    const notebookPath = (input.notebook_path as string) || '';
    const cellId = (input.cell_id as string) || '';
    const editMode = (input.edit_mode as string) || 'replace';
    const cellType = (input.cell_type as string) || '';

    // Shorten the path for display
    const shortPath = shortenPath(notebookPath, undefined, worktreeInfo);

    // Build details string
    const details: string[] = [];
    if (cellId) details.push(`cell: ${cellId}`);
    if (editMode && editMode !== 'replace') details.push(editMode);
    if (cellType) details.push(cellType);

    const detailStr = details.length > 0 ? ` (${details.join(', ')})` : '';

    // Use different emoji based on edit mode
    let emoji = '📓';
    if (editMode === 'insert') emoji = '➕';
    if (editMode === 'delete') emoji = '🗑️';

    return {
      display: `${emoji} ${formatter.formatBold('NotebookEdit')} ${formatter.formatCode(shortPath)}${detailStr}`,
      permissionText: `${emoji} ${formatter.formatBold('NotebookEdit')} ${formatter.formatCode(shortPath)}`,
      isDestructive: editMode === 'delete',
    };
  },
};
