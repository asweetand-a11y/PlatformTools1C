import { BaseCommand } from './baseCommand';
import { getRunEnterpriseCommandName, getRunDesignerCommandName } from '../commandNames';

/**
 * Команды для запуска 1С:Предприятие и Конфигуратора
 */
export class RunCommands extends BaseCommand {

	/**
	 * Запускает 1С:Предприятие
	 * Выполняет команду v8runner-cli.os runEnterprise
	 * @returns Промис, который разрешается после запуска команды
	 */
	async runEnterprise(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getRunEnterpriseCommandName();

		const args = [
			'runEnterprise',
			'--ibconnection', ibParams.connection,
			'--additional', '/NoWait'
		];

		if (ibParams.username) {
			args.push('--db-user', ibParams.username);
		}
		if (ibParams.password) {
			args.push('--db-pwd', ibParams.password);
		}

		this.vrunner.executeOscriptInTerminal(
			'oscript_modules/v8runner/src/v8runner-cli.os',
			args,
			{
				cwd: workspaceRoot,
				name: commandName.title
			}
		);
	}

	/**
	 * Запускает Конфигуратор
	 * Выполняет команду v8runner-cli.os runDesigner
	 * @returns Промис, который разрешается после запуска команды
	 */
	async runDesigner(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getRunDesignerCommandName();

		const args = [
			'runDesigner',
			'--ibconnection', ibParams.connection,
			'--additional', '/NoWait'
		];

		if (ibParams.username) {
			args.push('--db-user', ibParams.username);
		}
		if (ibParams.password) {
			args.push('--db-pwd', ibParams.password);
		}

		this.vrunner.executeOscriptInTerminal(
			'oscript_modules/v8runner/src/v8runner-cli.os',
			args,
			{
				cwd: workspaceRoot,
				name: commandName.title
			}
		);
	}
}
