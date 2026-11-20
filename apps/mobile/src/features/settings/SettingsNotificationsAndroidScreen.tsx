// fork: Android notifications come from connected servers, so these switches need no T3 Connect
// sign-in; the worker in serverPushRegistration.ts re-registers when they change.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getServerPushStatus,
  refreshServerPushRegistration,
  subscribeServerPushStatus,
} from "../agent-awareness/serverPushRegistration";
import type { ServerPushStatus } from "../agent-awareness/serverPushRegistration.logic";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const notificationPermissionAtom = makePermissionStatusAtom<"checking" | "enabled" | "disabled">({
  label: "mobile:android-notification-permission",
  initial: "checking",
  read: async () => {
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      return "disabled";
    }
    return result.value.granted ? "enabled" : "disabled";
  },
});

const STATUS_SUBTITLES: Record<ServerPushStatus, string | undefined> = {
  "no-servers": "Connect to a server to receive notifications",
  "no-token": "This device couldn't get a push token from Firebase",
  pending: undefined,
  delivering: undefined,
  unavailable: "Connected servers can't send notifications yet",
};

function openSystemSettingsAlert(title: string, message: string) {
  Dialog.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: "Open Settings", onPress: () => void Linking.openSettings() },
  ]);
}

export function SettingsNotificationsAndroidScreen() {
  const insets = useSafeAreaInsets();
  const pushAvailable = supportsAgentAwarenessPush();
  const permission = useAtomValue(notificationPermissionAtom);
  const setPermission = useAtomSet(notificationPermissionAtom);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const serverStatus = useSyncExternalStore(
    subscribeServerPushStatus,
    getServerPushStatus,
    getServerPushStatus,
  );
  const ongoingEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const subtitle = pushAvailable
    ? STATUS_SUBTITLES[serverStatus]
    : "Install a newer app build to enable notifications";

  const requestPermission = async (): Promise<boolean> => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(requestAgentNotificationPermission),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return false;
    }
    if (result.value.type === "granted") {
      setPermission("enabled");
      refreshServerPushRegistration();
      return true;
    }
    setPermission("disabled");
    if (result.value.type === "denied" && !result.value.canAskAgain) {
      openSystemSettingsAlert(
        "Notifications disabled",
        "Notifications were denied for this app. Open Settings to enable them.",
      );
    } else {
      Dialog.alert("Notifications disabled", "Notifications were not enabled.");
    }
    return false;
  };

  const handleNotificationsChange = (enabled: boolean) => {
    if (enabled) {
      void requestPermission();
      return;
    }
    openSystemSettingsAlert(
      "Disable notifications",
      "Open system Settings to disable notifications for T3 Code.",
    );
  };

  const handleOngoingChange = async (enabled: boolean) => {
    if (enabled && permission !== "enabled" && !(await requestPermission())) return;
    void savePreferences({ liveActivitiesEnabled: enabled });
  };

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Agent activity">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={!pushAvailable || permission === "checking"}
            subtitle={subtitle}
            value={pushAvailable && permission === "enabled"}
            onValueChange={handleNotificationsChange}
          />
          <SettingsSwitchRow
            icon="bolt.circle"
            label={
              supportsAndroidLiveUpdateSettings() ? "Agent Live Updates" : "Ongoing Agent Activity"
            }
            disabled={!pushAvailable || permission === "checking"}
            value={pushAvailable && permission === "enabled" && ongoingEnabled}
            onValueChange={(enabled) => void handleOngoingChange(enabled)}
          />
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label="Live Update Settings"
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Dialog.alert(
                    "Couldn't open Settings",
                    "Open Android Settings, select T3 Code, then enable Live Updates in Notifications.",
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
