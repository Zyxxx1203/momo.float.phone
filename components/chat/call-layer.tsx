"use client";

// 通话层：由 desktop-shell 常驻渲染，不再挂在聊天室内部。
//
// 原实现把通话界面 portal 进聊天室的父容器，于是通话只活在聊天室里——
// 返回会话列表就被隐藏，回手机桌面直接随聊天 App 一起卸载。
// 移到这里之后，切会话、回桌面、开别的 App 都不影响：通话全程由本组件持有，
// 缩成悬浮窗时也留在手机界面上。
//
// 会话与角色按 id 现取：避免全局状态里再存一份会话对象，改名或换头像后
// 悬浮窗显示旧值。

import { useEffect, useSyncExternalStore } from "react";

import { loadCharacters } from "@/lib/character-storage";
import { loadChatSessions } from "@/lib/chat-storage";
import {
    endCall,
    getActiveCall,
    startCall,
    getActiveCallServerSnapshot,
    minimizeCall,
    restoreCall,
    subscribeActiveCall,
} from "@/lib/call-session-store";
import { GroupCallScreen } from "./group-call-screen";
import { VoiceCallScreen } from "./voice-call-screen";
import { VideoCallScreen } from "./video-call-screen";

export function CallLayer() {
    // AI 主动来电（角色发起通话）：监听提升到这里。
    //
    // 原实现在聊天室里监听，还要求「聊天室当前可见」才响应——用户正在桌面上刷别的 App 时，
    // 后台生成出的通话标签会被直接丢弃，来电就此消失。通话层是常驻的，放这里才收得到。
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ sessionId?: string; type?: string; characterId?: string; characterName?: string }>).detail;
            if (!detail?.sessionId) return;
            if (getActiveCall()) return; // 通话中不打断当前通话
            const session = loadChatSessions().find(item => item.id === detail.sessionId);
            if (!session) return;
            startCall({
                // 群聊通话没有单一角色，交由 CallLayer 按会话成员渲染
                characterId: detail.characterId || (session.isGroup ? "" : session.contactId),
                sessionId: session.id,
                kind: detail.type === "video" ? "video" : "voice",
                initiator: "character",
                ...(detail.characterName ? { initiatorName: detail.characterName } : {}),
            });
            // 关掉可能正在显示的全局来电条，避免两处同时提示
            window.dispatchEvent(new CustomEvent("incoming-call-dismiss"));
        };
        window.addEventListener("ai-call-trigger", handler);
        return () => window.removeEventListener("ai-call-trigger", handler);
    }, []);

    const call = useSyncExternalStore(
        subscribeActiveCall,
        getActiveCall,
        getActiveCallServerSnapshot,
    );

    if (!call) return null;

    // 会话被删除时通话无从继续，直接收起。
    const session = loadChatSessions().find(item => item.id === call.sessionId);
    if (!session) return null;

    // 群聊通话没有单一角色，按会话里当前成员渲染（被踢出/退群的成员实时少一个）。
    if (session.isGroup) {
        const participants = session.participantIds || [];
        const allCharacters = loadCharacters();
        const members = participants
            .map(id => allCharacters.find(item => item.id === id))
            .filter((item): item is NonNullable<typeof item> => Boolean(item));
        if (members.length === 0) return null;
        return (
            // 兜底一层全屏定位容器：群通话组件的根类原本是聊天室内的直接子元素，
            // 换到桌面浮层后靠它保证铺满手机屏幕（与单聊通话的 absolute inset-0 对齐）。
            <div className="absolute inset-0 z-[100]">
                <GroupCallScreen
                    key={call.callId}
                    type={call.kind}
                    session={session}
                    characters={members}
                    initiator={call.initiator}
                    initiatorName={call.initiatorName}
                    onEnd={endCall}
                />
            </div>
        );
    }

    // 单聊：角色找不到就没法渲染通话界面，收起。
    const character = loadCharacters().find(item => item.id === call.characterId);
    if (!character) return null;

    const sharedProps = {
        key: call.callId,
        session,
        character,
        initiator: call.initiator,
        minimized: call.minimized,
        onMinimize: minimizeCall,
        onRestore: restoreCall,
        onEnd: endCall,
    };

    return call.kind === "voice"
        ? <VoiceCallScreen {...sharedProps} />
        : <VideoCallScreen {...sharedProps} />;
}
