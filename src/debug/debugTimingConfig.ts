/**
 * Чтение настроек таймингов отладки из конфигурации расширения.
 * Позволяет подстраивать задержки под медленные/быстрые серверы RDBG.
 */

import * as vscode from 'vscode';

export interface DebugTimingConfig {
	/** Задержка между retry при пустом ответе evalLocalVariables/evalExpr (мс). */
	varFetchDelayMs: number;
	/** calcWaitingTime в RDBG — время ожидания результата вычислений (мс). */
	calcWaitingTimeMs: number;
	/** Интервал опроса ping (rdbg pingDebugUIParams) в мс — когда отладчик «идет» (Continue). */
	pingIntervalMs: number;
	/** Интервал ping в режиме остановки (breakpoint/step) — реже, т.к. цели и стек не меняются. */
	pingStoppedIntervalMs: number;
	/** Задержка scheduleRefreshStackAndReveal для Step In/Out в мс. */
	stepInOutDelayMs: number;
	/** Интервалы немедленного ping после F11/Shift+F11 (мс). */
	immediatePingDelaysMs: number[];
	/** Задержки retry evalExpr при пустом ответе (мс). */
	evalExprRetryDelaysMs: number[];
	/** Задержки retry variablesRequest (evalLocalVariables) при пустом ответе (мс). Конфигуратор: retry при пустом response. */
	variablesRequestRetryDelaysMs: number[];
	/** Минимальный интервал между pingDBGTGT по одной цели (мс). */
	pingDbgtgtIntervalMs: number;
}

const DEFAULTS: DebugTimingConfig = {
	varFetchDelayMs: 50,
	calcWaitingTimeMs: 100,
	pingIntervalMs: 50,
	pingStoppedIntervalMs: 500,
	stepInOutDelayMs: 40,
	immediatePingDelaysMs: [25, 50, 100],
	evalExprRetryDelaysMs: [50, 100],
	variablesRequestRetryDelaysMs: [50, 100, 150],
	pingDbgtgtIntervalMs: 5000,
};

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function asNumberArray(val: unknown, fallback: number[]): number[] {
	if (!Array.isArray(val)) return fallback;
	const result = val
		.filter((v): v is number => typeof v === 'number' && v >= 0)
		.slice(0, 10);
	return result.length > 0 ? result : fallback;
}

/**
 * Читает настройки таймингов отладки из 1c-dev-tools.
 */
export function getDebugTimingConfig(): DebugTimingConfig {
	const cfg = vscode.workspace.getConfiguration('1c-dev-tools');
	return {
		varFetchDelayMs: clamp(
			cfg.get<number>('debug.timings.varFetchDelayMs', DEFAULTS.varFetchDelayMs),
			10,
			500,
		),
		calcWaitingTimeMs: clamp(
			cfg.get<number>('debug.timings.calcWaitingTimeMs', DEFAULTS.calcWaitingTimeMs),
			25,
			500,
		),
		pingIntervalMs: clamp(
			cfg.get<number>('debug.timings.pingIntervalMs', DEFAULTS.pingIntervalMs),
			50,
			1000,
		),
		pingStoppedIntervalMs: clamp(
			cfg.get<number>('debug.timings.pingStoppedIntervalMs', DEFAULTS.pingStoppedIntervalMs),
			100,
			2000,
		),
		stepInOutDelayMs: clamp(
			cfg.get<number>('debug.timings.stepInOutDelayMs', DEFAULTS.stepInOutDelayMs),
			15,
			300,
		),
		immediatePingDelaysMs: asNumberArray(
			cfg.get('debug.timings.immediatePingDelaysMs'),
			DEFAULTS.immediatePingDelaysMs,
		),
		evalExprRetryDelaysMs: asNumberArray(
			cfg.get('debug.timings.evalExprRetryDelaysMs'),
			DEFAULTS.evalExprRetryDelaysMs,
		),
		variablesRequestRetryDelaysMs: asNumberArray(
			cfg.get('debug.timings.variablesRequestRetryDelaysMs'),
			DEFAULTS.variablesRequestRetryDelaysMs,
		),
		pingDbgtgtIntervalMs: clamp(
			cfg.get<number>('debug.timings.pingDbgtgtIntervalMs', DEFAULTS.pingDbgtgtIntervalMs),
			200,
			60000,
		),
	};
}
