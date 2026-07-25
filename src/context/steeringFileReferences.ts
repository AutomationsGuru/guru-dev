import * as path from 'path';

/**
 * A function that reads the content of a file.
 * @param filePath The absolute path to the file.
 * @returns A promise that resolves to the file content as a string, or null if the file does not exist.
 */
type FileReader = (filePath: string) => Promise<string | null>;

/**
 * Expands #[[file:relative/path]] markers in a string with the content of the referenced files.
 *
 * @param text The input string containing file reference markers.
 * @param readFile A function to read file contents.
 * @param root The absolute path to the workspace root, used as a base for resolving relative paths.
 * @returns A promise that resolves to the string with file references expanded.
 */
export async function expand(text: string, readFile: FileReader, root: string): Promise<string> {
  const fileRefRegex = /#\[\[file:([^\]]+)\]\]/g;
  let result = text;

  const matches = [...text.matchAll(fileRefRegex)];

  for (const match of matches) {
    const fullMatch = match[0];
    const relativePath = match[1];

    if (!relativePath) {
        // This case should not happen with the given regex, but it satisfies typescript's strictness
        continue;
    }

    // Security: Validate the path. It must be relative and within the root.
    if (path.isAbsolute(relativePath) || relativePath.includes('..')) {
      result = result.replace(fullMatch, `[[Invalid path: ${relativePath}]]`);
      continue;
    }

    const absolutePath = path.resolve(root, relativePath);

    // Security: Double-check that the resolved path is still within the root.
    const normalizedRoot = path.normalize(root);
    const normalizedAbsolutePath = path.normalize(absolutePath);

    if (!normalizedAbsolutePath.startsWith(normalizedRoot + path.sep) && normalizedAbsolutePath !== normalizedRoot) {
        result = result.replace(fullMatch, `[[Invalid path: ${relativePath}]]`);
        continue;
    }

    const content = await readFile(absolutePath);

    if (content !== null) {
      result = result.replace(fullMatch, content);
    } else {
      result = result.replace(fullMatch, `[[File not found: ${relativePath}]]`);
    }
  }

  return result;
}
