import * as path from "node:path";

export interface MemoryBlock {
  name: string;
  content: string;
}

export interface ChangeSummary {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface InjectableFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, data: string, options?: { encoding?: "utf8" }): Promise<void>;
  readFile(path: string, options: { encoding: "utf8" }): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export async function exportToDir(
  blocks: MemoryBlock[],
  root: string,
  fs: InjectableFs
): Promise<ChangeSummary> {
  await fs.mkdir(root, { recursive: true });

  const existingFiles = new Set<string>();
  try {
    const files = await fs.readdir(root);
    for (const file of files) {
      if (file.endsWith(".md")) {
        existingFiles.add(file);
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  const changeSummary: ChangeSummary = { added: [], modified: [], deleted: [] };
  const currentBlockNames = new Set<string>();

  for (const block of blocks) {
    if (!block.name.match(/^[a-zA-Z0-9_-]+$/)) {
      throw new Error(`Invalid block name: ${block.name}`);
    }
    const fileName = `${block.name}.md`;
    currentBlockNames.add(fileName);
    const blockPath = path.join(root, fileName);

    // Path safety check
    const relative = path.relative(root, blockPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path traversal attempt: ${block.name}`);
    }

    let isModified = false;
    let isAdded = false;

    if (existingFiles.has(fileName)) {
      const existingContent = await fs.readFile(blockPath, { encoding: "utf8" });
      if (existingContent !== block.content) {
        isModified = true;
      }
    } else {
      isAdded = true;
    }

    if (isAdded || isModified) {
      await fs.writeFile(blockPath, block.content, { encoding: "utf8" });
      if (isAdded) changeSummary.added.push(block.name);
      if (isModified) changeSummary.modified.push(block.name);
    }
  }

  for (const file of existingFiles) {
    if (!currentBlockNames.has(file)) {
      const blockName = file.substring(0, file.length - 3);
      await fs.rm(path.join(root, file));
      changeSummary.deleted.push(blockName);
    }
  }

  return changeSummary;
}

export async function importFromDir(
  root: string,
  fs: InjectableFs
): Promise<MemoryBlock[]> {
  const blocks: MemoryBlock[] = [];
  try {
    const files = await fs.readdir(root);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const filePath = path.join(root, file);
      const relative = path.relative(root, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
         throw new Error(`Path traversal attempt: ${file}`);
      }

      const stats = await fs.stat(filePath);
      if (stats.isFile()) {
        const content = await fs.readFile(filePath, { encoding: "utf8" });
        const name = file.substring(0, file.length - 3); // remove .md
        blocks.push({ name, content });
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  return blocks;
}

export function suggestCommitMessage(changeSummary: ChangeSummary): string {
  const parts: string[] = [];

  if (changeSummary.added.length > 0) {
    parts.push(`added ${changeSummary.added.join(", ")}`);
  }
  if (changeSummary.modified.length > 0) {
    parts.push(`updated ${changeSummary.modified.join(", ")}`);
  }
  if (changeSummary.deleted.length > 0) {
    parts.push(`removed ${changeSummary.deleted.join(", ")}`);
  }

  if (parts.length === 0) {
    return "chore(memory): sync memory blocks";
  }

  return `chore(memory): ${parts.join("; ")}`;
}
