export interface SystemAgentToolEntry {
  id: string;
  config?: Record<string, unknown>;
}

export interface SystemAgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: SystemAgentToolEntry[];
  defaultModel: string | null;
  instructions: string;
  contentHash: string;
  templateId: string;
}
