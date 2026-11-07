import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    update: vi.fn(),
    canWrite: true,
    projectSelected: false,
  },
}));

vi.mock("react-native", () => ({ View: Children }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.canWrite }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: { permissionAtom: () => "permission" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: Children,
  AppTextInput: ({
    accessibilityLabel,
    defaultValue,
    editable,
    onEndEditing,
    onChangeText,
  }: {
    accessibilityLabel: string;
    defaultValue: string;
    editable: boolean;
    onChangeText: (text: string) => void;
    onEndEditing: (event: { nativeEvent: { text: string } }) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      defaultValue={defaultValue}
      disabled={!editable}
      onChange={(event) => onChangeText(event.target.value)}
      onBlur={(event) => onEndEditing({ nativeEvent: { text: event.target.value } })}
    />
  ),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  AndroidSettingsEnvironmentFilter: () => null,
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [
      {
        environmentId: "env",
        label: "Cacheos",
        serverConfig: { settings: { decision: { baseUrl: "", model: "openjev-0.1" } } },
      },
    ],
    selectedProjectKey: mocks.projectSelected ? "project" : null,
  }),
}));

import { SettingsDecisionsRouteScreen } from "./SettingsDecisionsRouteScreen";

let root: Root;
let container: HTMLDivElement;

const field = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

async function enter(label: string, text: string) {
  const input = field(label)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    input.blur();
  });
}

describe("SettingsDecisionsRouteScreen", () => {
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
    mocks.canWrite = true;
    mocks.projectSelected = false;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () => act(async () => root.render(<SettingsDecisionsRouteScreen />));

  it("saves the endpoint for the selected environment", async () => {
    await render();
    await enter("OpenJev endpoint", " http://127.0.0.1:19098 ");
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { patch: { decision: { baseUrl: "http://127.0.0.1:19098" } } },
    });
  });

  it("keeps the current model when the field is cleared", async () => {
    await render();
    await enter("Decision model", "");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a model name.");
  });

  it("reports a failed save", async () => {
    mocks.update.mockResolvedValue({ _tag: "Failure" });
    await render();
    await enter("OpenJev endpoint", "http://judge.test");
    expect(container.textContent).toContain("Could not save decision settings.");
  });

  it("locks the fields without settings write permission", async () => {
    mocks.canWrite = false;
    await render();
    expect(field("OpenJev endpoint")?.disabled).toBe(true);
    expect(field("Decision model")?.disabled).toBe(true);
  });

  it("asks for All projects while a project is selected", async () => {
    mocks.projectSelected = true;
    await render();
    expect(field("OpenJev endpoint")).toBeNull();
    expect(container.textContent).toContain("Select All projects");
  });
});
