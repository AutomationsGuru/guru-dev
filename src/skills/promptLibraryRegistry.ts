export interface PromptTemplate {
  id: string;
  description?: string;
  content: string;
}

export class PromptLibraryRegistry {
  private templates: Map<string, PromptTemplate> = new Map();

  add(template: PromptTemplate): void {
    if (this.templates.has(template.id)) {
      throw new Error(`Prompt template with id '${template.id}' already exists.`);
    }
    this.templates.set(template.id, template);
  }

  get(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }

  list(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }
}
