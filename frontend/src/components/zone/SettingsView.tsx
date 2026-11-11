"use client";

import { SendIcon, TrashIcon } from "@/components/Icons";
import { clearRecents, lobby, profile, recents } from "@/lib/people";
import { useStore } from "@/lib/store";

import { Footnote, Press, Switch, toast } from "./ui";
import { Row, ViewBody, ViewFoot, ViewFrame, ViewHead, type ViewProps } from "./ViewFrame";

export function SettingsView({ dir }: ViewProps) {
  const me = useStore(profile);
  const count = useStore(recents).length;

  const patch = (next: Partial<typeof me>) => profile.set((p) => ({ ...p, ...next }));

  return (
    <ViewFrame name="settings" dir={dir}>
      <ViewHead />
      <ViewBody>
        <Row>
          <label htmlFor="my-name" className="flabel">
            Your name
          </label>
          <input
            id="my-name"
            data-testid="settings-name"
            className="zfield"
            value={me.name}
            maxLength={40}
            placeholder="How others see you"
            autoComplete="name"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Row>
        <Row className="tgcard">
          <div className="tgcard__head">
            <span className="tgcard__icon">
              <SendIcon size={20} strokeWidth={2} />
            </span>
            <div>
              <p className="tgcard__title">Telegram invites</p>
              {/* TODO(telegram): "Connected as @… · via @kolo_bot" and a connect button once the bot exists */}
              <p className="tgcard__meta">Coming soon</p>
            </div>
          </div>
          <p className="tgcard__text">Invite people from Recent straight to Telegram, in one tap.</p>
        </Row>
        <Row className="zrow">
          <div>
            <label htmlFor="remember" className="zrow__title">
              Remember people I call
            </label>
            <p className="zrow__sub">Shown in Recent</p>
          </div>
          <Switch id="remember" label="Remember people I call" checked={me.rememberPeople} onChange={(v) => patch({ rememberPeople: v })} />
        </Row>
        <Row className="zrow">
          <div>
            <label htmlFor="lobby-default" className="zrow__title">
              Waiting room by default
            </label>
            <p className="zrow__sub">Approve guests first</p>
          </div>
          <Switch
            id="lobby-default"
            label="Waiting room by default"
            checked={me.lobbyDefault}
            onChange={(v) => {
              patch({ lobbyDefault: v });
              lobby.set(v);
            }}
          />
        </Row>
      </ViewBody>
      <ViewFoot>
        <Row>
          <Press
            className="dangerlink"
            disabled={!count}
            onClick={() => {
              const undo = clearRecents();
              toast("Recents cleared", { label: "Undo", run: undo });
            }}
          >
            <TrashIcon size={20} strokeWidth={1.9} />
            Clear recents
          </Press>
        </Row>
        <Row>
          <Footnote>Recents live in this browser only. Clearing site data removes them.</Footnote>
        </Row>
      </ViewFoot>
    </ViewFrame>
  );
}
