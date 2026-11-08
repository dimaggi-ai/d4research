import { useState } from "react";
import { Pressable, View } from "react-native";
import type { D4AgentMcpServer } from "@d4research/contracts";
import {
  EMPTY_NIA_MCP_SERVER_DRAFT,
  NIA_USER_SERVERS_NOTE,
  type NiaMcpServerDraft,
  niaMcpServerDraft,
  niaMcpServerFromDraft,
  niaMcpServerSummary,
} from "@d4research/client-runtime/niaServers";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Index of the server being edited, "new" for the add form, or null when nothing is open. */
type Editing = number | "new" | null;

function Field(props: {
  label: string;
  value: string;
  multiline?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <AppTextInput
      accessibilityLabel={props.label}
      placeholder={props.placeholder}
      value={props.value}
      multiline={props.multiline}
      autoCapitalize="none"
      autoCorrect={false}
      className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
      onChangeText={props.onChange}
    />
  );
}

export function NiaMcpServerList({
  servers,
  permissionMode,
  disabled,
  save,
}: {
  servers: ReadonlyArray<D4AgentMcpServer>;
  permissionMode: "read-only" | "ask" | "act";
  disabled: boolean;
  save: (servers: ReadonlyArray<D4AgentMcpServer>) => Promise<void>;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState<NiaMcpServerDraft>(EMPTY_NIA_MCP_SERVER_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const open = (next: Editing) => {
    setEditing(next);
    setError(null);
    setDraft(
      typeof next === "number" ? niaMcpServerDraft(servers[next]!) : EMPTY_NIA_MCP_SERVER_DRAFT,
    );
  };
  const submit = () => {
    const result = niaMcpServerFromDraft(
      draft,
      servers.filter((_, index) => index !== editing),
    );
    if ("error" in result) {
      setError(result.error);
      return;
    }
    void save(
      typeof editing === "number"
        ? servers.map((server, index) => (index === editing ? result.server : server))
        : [...servers, result.server],
    ).then(() => setEditing(null));
  };
  const button = (label: string, onPress: () => void, destructive = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      className="px-4 py-3"
      onPress={onPress}
    >
      <Text className={destructive ? "text-base text-destructive" : "text-base text-accent"}>
        {label}
      </Text>
    </Pressable>
  );
  const form = (
    <View className="gap-2 px-4 py-3">
      <Field
        label="MCP server name"
        placeholder="name, for example docs"
        value={draft.name}
        onChange={(name) => setDraft({ ...draft, name })}
      />
      {button(draft.type === "stdio" ? "Transport: command (stdio)" : "Transport: URL (HTTP)", () =>
        setDraft({ ...draft, type: draft.type === "stdio" ? "http" : "stdio" }),
      )}
      {draft.type === "stdio" ? (
        <>
          <Field
            label="MCP server command"
            placeholder="command, for example npx"
            value={draft.command}
            onChange={(command) => setDraft({ ...draft, command })}
          />
          <Field
            label="MCP server arguments"
            placeholder="Arguments, one per line"
            multiline
            value={draft.args}
            onChange={(args) => setDraft({ ...draft, args })}
          />
        </>
      ) : (
        <Field
          label="MCP server URL"
          placeholder="https://example.com/mcp"
          value={draft.url}
          onChange={(url) => setDraft({ ...draft, url })}
        />
      )}
      <Field
        label={draft.type === "stdio" ? "MCP server environment" : "MCP server headers"}
        placeholder={
          draft.type === "stdio"
            ? "Environment, KEY=value per line"
            : "Headers, Header-Name: value per line"
        }
        multiline
        value={draft.pairs}
        onChange={(pairs) => setDraft({ ...draft, pairs })}
      />
      <Text className="text-sm text-foreground-muted">
        Values are stored in this environment's settings and are visible to its paired clients.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
      <View className="flex-row">
        {button(editing === "new" ? "Add server" : "Save server", submit)}
        {button("Cancel", () => setEditing(null))}
      </View>
    </View>
  );
  return (
    <View>
      <Text className="px-4 py-3 text-sm text-foreground-muted">
        {NIA_USER_SERVERS_NOTE}
        {permissionMode === "act" ? "" : " They stay off until your permission level is Act."}
      </Text>
      {servers.map((server, index) => (
        <View key={server.name}>
          <SettingsSwitchRow
            icon="server.rack"
            label={server.name}
            subtitle={niaMcpServerSummary(server)}
            value={server.enabled}
            disabled={disabled}
            onValueChange={(enabled) =>
              void save(servers.map((item, at) => (at === index ? { ...item, enabled } : item)))
            }
          />
          <View className="flex-row">
            {button(`Edit ${server.name}`, () => open(index))}
            {button(
              `Remove ${server.name}`,
              () => {
                if (editing === index) setEditing(null);
                void save(servers.filter((_, at) => at !== index));
              },
              true,
            )}
          </View>
          {editing === index ? form : null}
        </View>
      ))}
      {editing === "new" ? (
        form
      ) : (
        <SettingsRow
          icon="plus"
          label="Add MCP server"
          disabled={disabled || servers.length >= 32}
          onPress={() => open("new")}
        />
      )}
    </View>
  );
}
