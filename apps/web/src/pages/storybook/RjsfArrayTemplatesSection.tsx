import type { RJSFSchema } from '@rjsf/utils';
import { useState } from 'react';

import { TemplateConfigForm } from '../graphs/components/TemplateConfigForm';

// An object-array field (mirrors the claudeAgent `plugins` schema) — the case
// that exposed @rjsf/core's invisible default array buttons.
const SCHEMA: RJSFSchema = {
  type: 'object',
  properties: {
    plugins: {
      type: 'array',
      title: 'Plugins',
      description:
        'Claude Code plugins to install for this agent (repo URL, optional ref/path).',
      items: {
        type: 'object',
        properties: {
          repoUrl: { type: 'string', title: 'Repository URL' },
          ref: { type: 'string', title: 'Ref (branch/tag)' },
          path: { type: 'string', title: 'Path' },
        },
        required: ['repoUrl'],
      },
    },
  },
};

export function RjsfArrayTemplatesSection() {
  const [formData, setFormData] = useState<Record<string, unknown>>({
    plugins: [
      { repoUrl: 'https://github.com/acme/claude-plugin', ref: 'main' },
    ],
  });

  return (
    <section id="rjsf-array-templates" className="scroll-mt-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold">RJSF Array Templates</h2>
        <p className="text-muted-foreground mt-0.5 text-sm">
          Object-array config fields (e.g. claudeAgent plugins) rendered with
          the shared Button + lucide add/remove/move controls, replacing
          @rjsf/core's invisible Bootstrap glyphicon defaults. Add, reorder, and
          remove rows to see the controls.
        </p>
      </div>
      <div className="border-border max-w-md rounded-lg border p-5">
        <TemplateConfigForm
          schema={SCHEMA}
          formData={formData}
          onChange={(next) => setFormData(next)}
          liteLlmModels={[]}
          litellmModelsLoading={false}
          onOpenExpandedTextarea={() => {}}
          onOpenAiSuggestion={() => {}}
          aiSuggestionEnabled={false}
        />
      </div>
    </section>
  );
}
