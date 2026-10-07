"use client";

// 通话「自动搭话」的运行时：三种通话屏（语音 / 视频 / 群聊）共用一套逻辑。
//
// 背景：煲电话粥时用户不说话，对面就一直干等。开启后在通话处于 IDLE
//（谁也没在说）且静默超过随机时长时，触发一次「无用户输入」的对话轮——
// 复用各通话屏自己的 runConversationTurn（不传 userText），让角色基于当前
// 上下文自己找话说，不额外拼提示词。
//
// 原先这段逻辑只写在语音通话屏里，视频/群聊要补同样能力时就只能再抄两份。
// 抽到这里后，三处共享同一份节拍与计数，设置也共用（lib/call-auto-chat）。

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import {
    type CallAutoChatConfig,
    loadCallAutoChatConfig,
    randomAutoChatDelaySeconds,
    saveCallAutoChatConfig,
} from "@/lib/call-auto-chat";

type UseCallAutoChatParams = {
    /** 通话是否进行中（CONNECTING / ENDED 之外）。结束后停表 */
    active: boolean;
    /** 读当前通话状态：只有 IDLE（谁也没在说）时才允许主动开口 */
    callStateRef: MutableRefObject<string>;
    /** 触发一次「角色主动开口」的对话轮 */
    runTurn: () => void;
    /** 开口前的准备（各通话屏在这里停掉在听的识别，免把角色自己的声音录进去） */
    beforeTrigger?: () => void;
    /** 倒计时归零、真的开口了（用于打日志或埋点；可选） */
    onTriggered?: () => void;
};

export function useCallAutoChat({
    active,
    callStateRef,
    runTurn,
    beforeTrigger,
    onTriggered,
}: UseCallAutoChatParams) {
    const [config, setConfig] = useState<CallAutoChatConfig>(() => loadCallAutoChatConfig());

    // 回调与状态走 ref：它们每秒都可能变，进了依赖会让心跳定时器反复重建
    const runTurnRef = useRef(runTurn);
    const beforeTriggerRef = useRef(beforeTrigger);
    const onTriggeredRef = useRef(onTriggered);
    runTurnRef.current = runTurn;
    beforeTriggerRef.current = beforeTrigger;
    onTriggeredRef.current = onTriggered;

    const configRef = useRef(config);
    configRef.current = config;

    // 下一次可开口的时刻（毫秒时间戳，0 = 尚未排期）
    const deadlineRef = useRef(0);
    // 本次通话已自动开口条数（用户一开口清零）
    const turnsRef = useRef(0);
    // 角色连着几轮没说出内容：等待时长按此翻倍，避免空转连发
    const emptyTurnsRef = useRef(0);

    /**
     * 安排下一次开口。
     * 每次角色说完（或空转一趟）都调一次：按配置在 [min, max] 里随机取间隔，
     * 真人是忽快忽慢的，固定节拍像定时器。空转那几轮按翻倍惩罚（最多 4 倍）。
     */
    const schedule = useCallback(() => {
        const current = configRef.current;
        if (!current.enabled) {
            deadlineRef.current = 0;
            return;
        }
        const backoff = 1 + Math.min(emptyTurnsRef.current, 3);
        deadlineRef.current = Date.now() + randomAutoChatDelaySeconds(current) * backoff * 1000;
    }, []);

    /** 用户开口了：重新计数（上限按「你开口后」重新算） */
    const notifyUserSpoke = useCallback(() => {
        turnsRef.current = 0;
        emptyTurnsRef.current = 0;
        deadlineRef.current = 0;
    }, []);

    /**
     * 角色说完一轮。
     * @param produced 这一轮是否真的说出了内容（false = 空转，下次等更久）
     */
    const notifyAssistantSpoke = useCallback((produced: boolean) => {
        emptyTurnsRef.current = produced ? 0 : emptyTurnsRef.current + 1;
        schedule();
    }, [schedule]);

    /** 改设置并即时生效（存盘 + 广播给其它页面），顺带把节拍复位 */
    const update = useCallback((patch: Partial<CallAutoChatConfig>) => {
        const before = configRef.current;
        const next = saveCallAutoChatConfig({ ...before, ...patch });
        setConfig(next);
        configRef.current = next;
        // 开关或上限变了：计数从头来（用户刚拨动开关，不该接着旧的算）
        if (next.enabled !== before.enabled || next.maxTurns !== before.maxTurns) {
            turnsRef.current = 0;
            emptyTurnsRef.current = 0;
        }
        // 间隔或开关变了：重新排期，改动立刻见效
        if (
            next.enabled !== before.enabled
            || next.minSeconds !== before.minSeconds
            || next.maxSeconds !== before.maxSeconds
        ) {
            deadlineRef.current = next.enabled
                ? Date.now() + randomAutoChatDelaySeconds(next) * 1000
                : 0;
        }
        return next;
    }, []);

    // 心跳：每秒看一眼是否到了开口时刻。
    // 缩成小窗 / 切到后台也照常触发——用户要的就是「挂着也一直聊」。
    useEffect(() => {
        if (!active) {
            deadlineRef.current = 0;
            return;
        }
        if (!config.enabled) {
            deadlineRef.current = 0;
            return;
        }
        // 刚开启（或刚进通话）：从当下起算一个随机间隔
        if (!deadlineRef.current) {
            deadlineRef.current = Date.now() + randomAutoChatDelaySeconds(config) * 1000;
        }
        const timer = window.setInterval(() => {
            if (callStateRef.current !== "IDLE") return;
            const current = configRef.current;
            if (!current.enabled) return;
            const limit = current.maxTurns;
            if (limit > 0 && turnsRef.current >= limit) return;
            const deadline = deadlineRef.current;
            if (!deadline || Date.now() < deadline) return;
            turnsRef.current += 1;
            deadlineRef.current = 0;
            beforeTriggerRef.current?.();
            onTriggeredRef.current?.();
            runTurnRef.current();
        }, 1000);
        return () => window.clearInterval(timer);
        // callStateRef / runTurn 走 ref，不进依赖
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, config]);

    return { config, update, schedule, notifyUserSpoke, notifyAssistantSpoke };
}
