/**
 * Последний запуск dbgs (команда и ownerPID) для вывода в Debug Console.
 * Записывается при активации расширения, читается в debugSession.
 */
export interface DbgsLaunchInfo {
	commandLine: string;
	ownerPid: number;
}

let lastLaunch: DbgsLaunchInfo | null = null;

export function setLastDbgsLaunch(info: DbgsLaunchInfo): void {
	lastLaunch = info;
}

export function getLastDbgsLaunch(): DbgsLaunchInfo | null {
	return lastLaunch;
}
