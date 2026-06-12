import type {
  ArrayFieldItemTemplateProps,
  ArrayFieldTemplateProps,
  IconButtonProps,
  RJSFSchema,
} from '@rjsf/utils';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';

import { Button } from '../../../components/ui/button';

// @rjsf/core ships its default array Add/Remove/Move buttons as Bootstrap
// glyphicon `<i>` markup (`<i class="glyphicon glyphicon-plus">`). This app loads
// no Bootstrap CSS (Tailwind + Radix + lucide only, per web-patterns.md), so those
// glyphs render invisibly — making object-array fields (e.g. the claudeAgent
// `plugins` list) practically unconfigurable. These templates re-render the array
// scaffolding with the shared Button + lucide icons.

type FormData = Record<string, unknown>;
type FormContext = Record<string, unknown>;
type RjsfIconButtonProps = IconButtonProps<FormData, RJSFSchema, FormContext>;

// Strip the RJSF-only props (icon glyph name, bootstrap className, uiSchema,
// registry) that must not reach the DOM button; `rest` carries onClick/disabled.
// Mirrors @rjsf/core's own IconButton destructure.
const RjsfAddButton = ({
  icon: _icon,
  iconType: _iconType,
  className: _className,
  uiSchema: _uiSchema,
  registry: _registry,
  ...rest
}: RjsfIconButtonProps) => (
  <Button {...rest} type="button" variant="outline" size="sm" title="Add item">
    <Plus className="size-4" />
    Add
  </Button>
);

const RjsfRemoveButton = ({
  icon: _icon,
  iconType: _iconType,
  className: _className,
  uiSchema: _uiSchema,
  registry: _registry,
  ...rest
}: RjsfIconButtonProps) => (
  <Button
    {...rest}
    type="button"
    variant="ghost"
    size="icon"
    className="text-muted-foreground hover:text-destructive size-7"
    title="Remove item">
    <Trash2 className="size-3.5" />
  </Button>
);

const RjsfMoveUpButton = ({
  icon: _icon,
  iconType: _iconType,
  className: _className,
  uiSchema: _uiSchema,
  registry: _registry,
  ...rest
}: RjsfIconButtonProps) => (
  <Button
    {...rest}
    type="button"
    variant="ghost"
    size="icon"
    className="size-7"
    title="Move up">
    <ChevronUp className="size-3.5" />
  </Button>
);

const RjsfMoveDownButton = ({
  icon: _icon,
  iconType: _iconType,
  className: _className,
  uiSchema: _uiSchema,
  registry: _registry,
  ...rest
}: RjsfIconButtonProps) => (
  <Button
    {...rest}
    type="button"
    variant="ghost"
    size="icon"
    className="size-7"
    title="Move down">
    <ChevronDown className="size-3.5" />
  </Button>
);

// Lays out one array item: its nested content on the left, the move/remove/copy
// toolbar (delegated to RJSF's ArrayFieldItemButtonsTemplate, which dispatches to
// the custom ButtonTemplates above) on the right — replacing @rjsf/core's
// `.col-xs-*` Bootstrap grid with a Tailwind flex row.
const RjsfArrayFieldItemTemplate = (
  props: ArrayFieldItemTemplateProps<FormData, RJSFSchema, FormContext>,
) => {
  const { children, buttonsProps, hasToolbar, registry } = props;
  const { ArrayFieldItemButtonsTemplate } = registry.templates;
  return (
    <div className="flex items-start gap-2 rounded-md border p-2">
      <div className="min-w-0 flex-1">{children}</div>
      {hasToolbar && (
        <div className="flex shrink-0 items-center gap-1">
          <ArrayFieldItemButtonsTemplate {...buttonsProps} />
        </div>
      )}
    </div>
  );
};

// Renders the array: the stack of item rows plus a visible Add button when more
// items can be added — replacing @rjsf/core's `fieldset`/`.row` Bootstrap markup.
const RjsfArrayFieldTemplate = (
  props: ArrayFieldTemplateProps<FormData, RJSFSchema, FormContext>,
) => {
  const { canAdd, items, onAddClick, disabled, readonly, registry, uiSchema } =
    props;
  const { AddButton } = registry.templates.ButtonTemplates;
  return (
    <div className="space-y-3">
      {items.length > 0 && <div className="space-y-3">{items}</div>}
      {canAdd && (
        <AddButton
          onClick={onAddClick}
          disabled={disabled || readonly}
          uiSchema={uiSchema}
          registry={registry}
        />
      )}
    </div>
  );
};

export {
  RjsfAddButton,
  RjsfArrayFieldItemTemplate,
  RjsfArrayFieldTemplate,
  RjsfMoveDownButton,
  RjsfMoveUpButton,
  RjsfRemoveButton,
};
