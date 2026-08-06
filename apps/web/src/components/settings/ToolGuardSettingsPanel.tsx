import { useEffect, useState } from "react";
import {
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
  ShieldBanIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import type { ToolGuardPolicyRule, ToolGuardRuleEffect } from "@t3tools/contracts";

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
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useToolGuardStatus } from "../../hooks/useToolGuardStatus";
import { useToolGuardPolicy } from "../../hooks/useToolGuardPolicy";

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
  readOnly,
  onEdit,
  onDelete,
}: {
  readonly rule: ToolGuardPolicyRule;
  readonly readOnly?: boolean;
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
      {readOnly ? null : (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onEdit}
            aria-label={`Edit ${rule.rule_id}`}
          >
            <PencilIcon className="size-3" />
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
      )}
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
          <Button
            onClick={() => {
              const trimmedId = ruleId.trim();
              if (!trimmedId) return;
              onSave({
                rule_id: trimmedId,
                rule_type: "regex",
                conditions: { field, operator: "regex", value: pattern },
                effect,
                citation: { excerpt: excerpt.trim() },
              });
              onOpenChange(false);
            }}
            disabled={!ruleId.trim()}
          >
            {isNew ? "Add Rule" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ToolGuardSettingsPanel() {
  const toolGuardStatus = useToolGuardStatus();
  const toolGuardPolicy = useToolGuardPolicy(true);
  const canEditPolicy = toolGuardStatus.installed && toolGuardPolicy.source === "managed";
  const [editingRule, setEditingRule] = useState<ToolGuardPolicyRule | null>(null);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [isNewRule, setIsNewRule] = useState(false);

  const handleAddRule = () => {
    setEditingRule(null);
    setIsNewRule(true);
    setRuleDialogOpen(true);
  };

  const handleEditRule = (rule: ToolGuardPolicyRule) => {
    setEditingRule(rule);
    setIsNewRule(false);
    setRuleDialogOpen(true);
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!toolGuardPolicy.policy) return;
    const updated = {
      ...toolGuardPolicy.policy,
      rules: toolGuardPolicy.policy.rules.filter((r) => r.rule_id !== ruleId),
    };
    await toolGuardPolicy.save(updated);
  };

  const handleSaveRule = async (rule: ToolGuardPolicyRule) => {
    if (!toolGuardPolicy.policy) return;
    const rules = isNewRule
      ? [...toolGuardPolicy.policy.rules, rule]
      : toolGuardPolicy.policy.rules.map((r) => (r.rule_id === rule.rule_id ? rule : r));
    await toolGuardPolicy.save({ ...toolGuardPolicy.policy, rules });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Integration">
        <SettingsRow
          title="Native provider permissions"
          description="The default. Access modes use each provider's built-in sandbox and approval behavior."
          control={
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheckIcon className="size-4" />
              {toolGuardStatus.integration === "external"
                ? "Overridden externally"
                : toolGuardStatus.enabled
                  ? "Replaced by Tool Guard"
                  : "Active"}
            </span>
          }
        />
        <SettingsRow
          title="d4research Tool Guard"
          description="Optional environment-local policy enforcement for Codex, Claude, and Antigravity."
          status={toolGuardStatus.message}
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheckIcon
                  className={toolGuardStatus.enabled ? "size-4 text-emerald-500" : "size-4"}
                />
                {toolGuardStatus.integration === "external"
                  ? "Externally managed"
                  : toolGuardStatus.integration === "managed"
                    ? "Enabled"
                    : toolGuardStatus.integration === "disabled"
                      ? "Disabled"
                      : toolGuardStatus.integration === "available"
                        ? "Available"
                        : "Unavailable"}
              </span>
              {toolGuardStatus.canInstall ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={toolGuardStatus.action !== null}
                  onClick={() => void toolGuardStatus.runAction("install")}
                >
                  Install
                </Button>
              ) : null}
              {toolGuardStatus.canReplaceExternal ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={toolGuardStatus.action !== null}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Replace external Tool Guard hooks with the d4research-managed integration?\n\nOnly Tool Guard hook entries will be removed. Other provider hooks remain unchanged. Removed external Tool Guard entries are not restored by Uninstall.\n\nDetected in:\n${toolGuardStatus.externalHookConfigPaths.join("\n")}`,
                      )
                    ) {
                      void toolGuardStatus.runAction("replace-external");
                    }
                  }}
                >
                  Replace with d4research
                </Button>
              ) : null}
              {toolGuardStatus.canManage ? (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={toolGuardStatus.action !== null}
                    onClick={() =>
                      void toolGuardStatus.runAction(toolGuardStatus.enabled ? "disable" : "enable")
                    }
                  >
                    {toolGuardStatus.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={toolGuardStatus.action !== null}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Uninstall the d4research Tool Guard integration from this environment?",
                        )
                      ) {
                        void toolGuardStatus.runAction("uninstall");
                      }
                    }}
                  >
                    Uninstall
                  </Button>
                </>
              ) : null}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title="Policy Rules">
        {toolGuardPolicy.state === "ready" && toolGuardPolicy.policy ? (
          <p className="text-xs text-muted-foreground">
            {toolGuardPolicy.policy.rules.length} rule
            {toolGuardPolicy.policy.rules.length === 1 ? "" : "s"} in {toolGuardPolicy.policy.mode}{" "}
            mode. Scope:{" "}
            {[
              ...toolGuardPolicy.policy.scope.tool_names,
              ...toolGuardPolicy.policy.scope.tool_groups.map((g) => `@${g}`),
            ].join(", ") || "all tools"}
            .
          </p>
        ) : null}
        {toolGuardPolicy.state === "ready" && toolGuardPolicy.policy ? (
          <>
            {!canEditPolicy ? (
              <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                {toolGuardPolicy.source === "bundled"
                  ? "Showing the bundled default policy. Install the d4research-managed integration above to edit rules; editing is disabled while Tool Guard hooks are managed externally."
                  : "Policy editing is unavailable until the d4research-managed integration is installed."}
              </p>
            ) : null}
            <div className="flex items-center justify-between px-1 py-2">
              <span className="text-xs font-medium text-muted-foreground">
                {toolGuardPolicy.policy.rules.length === 0
                  ? "No rules configured yet."
                  : `${toolGuardPolicy.policy.rules.length} active rule${toolGuardPolicy.policy.rules.length === 1 ? "" : "s"}`}
              </span>
              {canEditPolicy ? (
                <Button size="xs" variant="outline" onClick={handleAddRule}>
                  <PlusIcon className="mr-1 size-3" />
                  Add Rule
                </Button>
              ) : null}
            </div>
            <div className="space-y-1.5">
              {toolGuardPolicy.policy.rules.map((rule) => (
                <RuleCard
                  key={rule.rule_id}
                  rule={rule}
                  readOnly={!canEditPolicy}
                  onEdit={() => handleEditRule(rule)}
                  onDelete={() => void handleDeleteRule(rule.rule_id)}
                />
              ))}
            </div>
            {toolGuardPolicy.error ? (
              <p className="mt-2 text-xs text-destructive">{toolGuardPolicy.error}</p>
            ) : null}
          </>
        ) : toolGuardPolicy.state === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">Loading policy rules...</p>
        ) : (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No Tool Guard policy is available. Install Tool Guard above to create one.
          </p>
        )}
      </SettingsSection>

      <RuleEditDialog
        open={ruleDialogOpen}
        onOpenChange={setRuleDialogOpen}
        rule={isNewRule ? null : editingRule}
        onSave={(rule) => void handleSaveRule(rule)}
      />
    </SettingsPageContainer>
  );
}
