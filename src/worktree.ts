import { statSync, readFileSync } from "node:fs"
import { join, basename } from "node:path"

export interface WorktreeInfo {
  isWorktree: boolean
  worktreeName: string | null
  parentRepoPath: string | null
  parentProjectName: string | null
}

const NOT_A_WORKTREE: WorktreeInfo = {
  isWorktree: false,
  worktreeName: null,
  parentRepoPath: null,
  parentProjectName: null,
}

/**
 * Detects if a directory is a git worktree and extracts parent repository info.
 *
 * Git worktrees have a `.git` file (not directory) containing:
 *   gitdir: /path/to/parent/.git/worktrees/<name>
 *
 * @param cwd - Current working directory (absolute path).
 * @returns WorktreeInfo with parent details when inside a worktree.
 */
export function detectWorktree(cwd: string): WorktreeInfo {
  const gitPath = join(cwd, ".git")

  let stat
  try {
    stat = statSync(gitPath)
  } catch {
    return NOT_A_WORKTREE
  }

  if (!stat.isFile()) {
    return NOT_A_WORKTREE
  }

  let content: string
  try {
    content = readFileSync(gitPath, "utf-8").trim()
  } catch {
    return NOT_A_WORKTREE
  }

  const match = content.match(/^gitdir:\s*(.+)$/)
  if (!match) {
    return NOT_A_WORKTREE
  }

  const gitdirPath = match[1]!
  const worktreesMatch = gitdirPath.match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/)
  if (!worktreesMatch) {
    return NOT_A_WORKTREE
  }

  const parentRepoPath = worktreesMatch[1]!

  return {
    isWorktree: true,
    worktreeName: basename(cwd),
    parentRepoPath,
    parentProjectName: basename(parentRepoPath),
  }
}
