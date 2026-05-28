export interface CharacterCard {
  id: number;
  project_id: number;
  name: string;
  source_type: 'json' | 'png';
  data_json: string;
  created_at: string;
}

export interface CCV3Data {
  spec: string;
  spec_version: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  creator: string;
  character_version: string;
  alternate_greetings: string[];
  extensions: Record<string, unknown>;
  character_book?: {
    name?: string;
    description?: string;
    scan_depth?: number;
    token_budget?: number;
    recursive_scanning?: boolean;
    entries: WorldBookEntryRaw[];
  };
}

export interface WorldBookEntryRaw {
  keys: string;
  secondary_keys?: string;
  content: string;
  extensions: Record<string, unknown>;
  enabled: boolean;
  insertion_order: number;
  position?: string | number;
  comment?: string;
}
