import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangleIcon,
  PlusIcon,
  ShieldAlertIcon,
  ShieldBanIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import type {
  ToolGuardPolicy,
  ToolGuardPolicyRule,
  ToolGuardRuleEffect,
} from "@d4research/contracts";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const EFFECT_LABELS: Record<ToolGuardRuleEffect, string> = {
  deny: "Deny",
  escalate: "Escalate",
  allow: "Allow",
};

const EFFECT_ICONS: Record<ToolGuardRuleEffect, typeof ShieldBanIcon> = {
  deny: ShieldBanIcon,
  escalate: ShieldAlertIcon,
  allow: ShieldCheckIcon,
};

const EFFECT_COLORS: Record<ToolGuardRuleEffect, string> = {
  deny: "text-red-500",
  escalate: "text-amber-500",
  allow: "text-emerald-500",
};

function conditionSummary(rule: ToolGuardPolicyRule): string {
  const { conditions } = rule;
  if (conditions.and) {
    return conditions.and
      .map((c) => {
        if (c.or)
          return `(${c.or
            .map((o) => o.value ?? "")
            .filter(Boolean)
            .join(" | ")})`;
        return c.value ?? "";
      })
      .filter(Boolean)
      .join(" + ");
  }
  if (conditions.or) {
    return conditions.or
      .map((c) => c.value ?? "")
      .filter(Boolean)
      .join(" | ");
  }
  return conditions.value ?? "";
}

function RuleCard({
  rule,
  onEdit,
  onDelete,
}: {
  readonly rule: ToolGuardPolicyRule;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const EffectIcon = EFFECT_ICONS[rule.effect];
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5">
      <EffectIcon className={`mt-0.5 size-4 shrink-0 ${EFFECT_COLORS[rule.effect]}`} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{rule.rule_id}</span>
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${EFFECT_COLORS[rule.effect]} bg-current/10`}
          >
            {EFFECT_LABELS[rule.effect]}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{rule.citation.excerpt}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground/60">
          {conditionSummary(rule)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="icon-xs" variant="ghost" onClick={onEdit} aria-label={`Edit ${rule.rule_id}`}>
          <AlertTriangleIcon className="size-3" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onDelete}
          aria-label={`Delete ${rule.rule_id}`}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function RuleEditDialog({
  open,
  onOpenChange,
  rule,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly rule: ToolGuardPolicyRule | null;
  readonly onSave: (rule: ToolGuardPolicyRule) => void;
}) {
  const isNew = rule === null;
  const [ruleId, setRuleId] = useState("");
  const [effect, setEffect] = useState<ToolGuardRuleEffect>("escalate");
  const [excerpt, setExcerpt] = useState("");
  const [field, setField] = useState("parameters.command");
  const [pattern, setPattern] = useState("");

  useEffect(() => {
    if (open) {
      if (rule) {
        setRuleId(rule.rule_id);
        setEffect(rule.effect);
        setExcerpt(rule.citation.excerpt);
        setField(rule.conditions.field ?? rule.conditions.and?.[0]?.field ?? "parameters.command");
        setPattern(rule.conditions.value ?? rule.conditions.and?.[0]?.value ?? "");
      } else {
        setRuleId("");
        setEffect("escalate");
        setExcerpt("");
        setField("parameters.command");
        setPattern("");
      }
    }
  }, [open, rule]);

  const handleSave = () => {
    const trimmedId = ruleId.trim();
    if (!trimmedId) return;
    onSave({
      rule_id: trimmedId,
      rule_type: "regex",
      conditions: {
        field,
        operator: "regex",
        value: pattern,
      },
      effect,
      citation: { excerpt: excerpt.trim() },
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add Policy Rule" : "Edit Policy Rule"}</DialogTitle>
          <DialogDescription>
            {isNew
              ? "Create a new rule to match tool invocations."
              : `Editing rule "${rule?.rule_id}".`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-6 pb-5">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Rule ID</label>
            <Input
              value={ruleId}
              onChange={(e) => setRuleId(e.currentTarget.value)}
              placeholder="deny-dangerous-command"
              disabled={!isNew}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Effect</label>
            <Select
              value={effect}
              onValueChange={(value) => {
                if (value === "deny" || value === "escalate" || value === "allow") {
                  setEffect(value);
                }
              }}
            >
              <SelectTrigger className="w-full" aria-label="Rule effect">
                <SelectValue>{EFFECT_LABELS[effect]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="deny">Deny</SelectItem>
                <SelectItem value="escalate">Escalate</SelectItem>
                <SelectItem value="allow">Allow</SelectItem>
              </SelectPopup>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Match field</label>
            <Input
              value={field}
              onChange={(e) => setField(e.currentTarget.value)}
              placeholder="parameters.command"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Regex pattern</label>
            <DraftInput
              value={pattern}
              onCommit={setPattern}
              placeholder="\\bgit\\s+push\\b"
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Description</label>
            <DraftInput
              value={excerpt}
              onCommit={setExcerpt}
              placeholder="What this rule guards against."
            />
          </div>
        </DialogPanel>
        <DialogFooter className="px-6 pb-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!ruleId.trim()}>
            {isNew ? "Add Rule" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ToolGuardPolicyEditor({
  open,
  onOpenChange,
  policy,
  saving,
  error,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly policy: ToolGuardPolicy | null;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onSave: (policy: ToolGuardPolicy) => Promise<boolean>;
}) {
  const [localRules, setLocalRules] = useState<ToolGuardPolicyRule[]>([]);
  const [scope, setScope] = useState({ toolNames: "", toolGroups: "" });
  const [editingRule, setEditingRule] = useState<ToolGuardPolicyRule | null>(null);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [isNewRule, setIsNewRule] = useState(false);

  useEffect(() => {
    if (open && policy) {
      setLocalRules([...policy.rules]);
      setScope({
        toolNames: policy.scope.tool_names.join(", "),
        toolGroups: policy.scope.tool_groups.join(", "),
      });
    }
  }, [open, policy]);

  const handleAddRule = useCallback(() => {
    setEditingRule(null);
    setIsNewRule(true);
    setRuleDialogOpen(true);
  }, []);

  const handleEditRule = useCallback((rule: ToolGuardPolicyRule) => {
    setEditingRule(rule);
    setIsNewRule(false);
    setRuleDialogOpen(true);
  }, []);

  const handleDeleteRule = useCallback((ruleId: string) => {
    setLocalRules((rules) => rules.filter((r) => r.rule_id !== ruleId));
  }, []);

  const handleSaveRule = useCallback(
    (rule: ToolGuardPolicyRule) => {
      if (isNewRule) {
        setLocalRules((rules) => [...rules, rule]);
      } else {
        setLocalRules((rules) => rules.map((r) => (r.rule_id === rule.rule_id ? rule : r)));
      }
    },
    [isNewRule],
  );

  const handleSavePolicy = useCallback(async () => {
    if (!policy) return;
    const toolNames = scope.toolNames
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const toolGroups = scope.toolGroups
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const updated: ToolGuardPolicy = {
      ...policy,
      scope: { tool_names: toolNames, tool_groups: toolGroups },
      rules: localRules,
    };
    const ok = await onSave(updated);
    if (ok) onOpenChange(false);
  }, [localRules, onOpenChange, onSave, policy, scope]);

  if (!policy) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Tool Guard Policy</DialogTitle>
            <DialogDescription>
              {policy.name} — {policy.mode} mode
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4 px-6 pb-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Tool names (scope)</label>
                <Input
                  value={scope.toolNames}
                  onChange={(e) => setScope((s) => ({ ...s, toolNames: e.currentTarget.value }))}
                  placeholder="bash, shell, run_command"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">Tool groups (scope)</label>
                <Input
                  value={scope.toolGroups}
                  onChange={(e) => setScope((s) => ({ ...s, toolGroups: e.currentTarget.value }))}
                  placeholder="shell"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-foreground">Rules ({localRules.length})</h4>
                <Button size="xs" variant="outline" onClick={handleAddRule}>
                  <PlusIcon className="mr-1 size-3" />
                  Add Rule
                </Button>
              </div>
              {localRules.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No rules configured. Add one to start enforcing policies.
                </p>
              ) : (
                <div className="max-h-80 space-y-1.5 overflow-y-auto">
                  {localRules.map((rule) => (
                    <RuleCard
                      key={rule.rule_id}
                      rule={rule}
                      onEdit={() => handleEditRule(rule)}
                      onDelete={() => handleDeleteRule(rule.rule_id)}
                    />
                  ))}
                </div>
              )}
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter className="px-6 pb-6">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void handleSavePolicy()} disabled={saving}>
              {saving ? "Saving…" : "Save Policy"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <RuleEditDialog
        open={ruleDialogOpen}
        onOpenChange={setRuleDialogOpen}
        rule={isNewRule ? null : editingRule}
        onSave={handleSaveRule}
      />
    </>
  );
}
