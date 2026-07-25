export interface RecipeShellInjectConfirmPayload {
  readonly needsConfirm: boolean;
  readonly commands: readonly string[];
  readonly note?: string;
}

/** Extract every complete `!{...}` shell inject block from recipe text, in source order. */
export function extractInjects(recipeText: string): string[] {
  const commands: string[] = [];

  for (let index = 0; index < recipeText.length; index += 1) {
    if (recipeText[index] !== "!" || recipeText[index + 1] !== "{") {
      continue;
    }

    let cursor = index + 2;
    let depth = 1;
    let command = "";

    while (cursor < recipeText.length && depth > 0) {
      const char = recipeText[cursor] ?? "";

      if (char === "{") {
        depth += 1;
        command += char;
        cursor += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
        command += char;
        cursor += 1;
        continue;
      }

      command += char;
      cursor += 1;
    }

    if (depth === 0) {
      const trimmed = command.trim();
      if (trimmed.length > 0) {
        commands.push(trimmed);
      }
      index = cursor;
    }
  }

  return commands;
}

/** Build the confirmation payload a caller can require before executing recipe shell injects. */
export function needsConfirm(recipeText: string): RecipeShellInjectConfirmPayload {
  const commands = extractInjects(recipeText);

  if (commands.length === 0) {
    return {
      needsConfirm: false,
      commands: []
    };
  }

  const hasArgsPlaceholder = commands.some((command) => command.includes("{{args}}"));

  return {
    needsConfirm: true,
    commands,
    ...(hasArgsPlaceholder
      ? {
          note: "Recipe shell inject commands include {{args}}; confirm the exact command text and ensure args are shell-escaped before execution."
        }
      : {})
  };
}
