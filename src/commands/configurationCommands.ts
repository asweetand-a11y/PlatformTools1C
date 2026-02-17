import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { BaseCommand } from './baseCommand';
import {
	getLoadConfigurationFromSrcCommandName,
	getUpdateConfigurationFromSrcWithCommitCommandName,
	getLoadConfigurationFromCfCommandName,
	getDumpConfigurationToSrcCommandName,
	getDumpUpdateConfigurationToSrcCommandName,
	getDumpConfigurationToCfCommandName,
	getDumpConfigurationToDistCommandName,
	getBuildConfigurationCommandName,
	getDecompileConfigurationCommandName
} from '../commandNames';

/**
 * Команды для работы с конфигурацией
 */
export class ConfigurationCommands extends BaseCommand {

	/**
	 * Загружает конфигурацию из исходников в информационную базу
	 * @param mode - Режим загрузки: 'init' для инициализации, 'update' для обновления
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Загружает конфигурацию из исходников в информационную базу
	 * 
	 * Использует v8runner-cli.os для загрузки конфигурации из исходников.
	 * 
	 * @param mode - Режим загрузки: 'init' для инициализации, 'update' для обновления
	 * @returns Промис, который разрешается после запуска команды
	 */
	async loadFromSrc(mode: 'init' | 'update' = 'update'): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const srcPath = this.vrunner.getSrcPath();
		const absoluteSrcPath = path.isAbsolute(srcPath) 
			? srcPath 
			: path.join(workspaceRoot, srcPath);
		
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getLoadConfigurationFromSrcCommandName(mode);

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}
		
		// Получаем путь к oscript
		const onescriptPath = this.vrunner.getOnescriptPath();
		
		// Аргументы для универсального CLI с абсолютными путями
		const args = [
			scriptPath,
			'loadConfigFromFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--src', absoluteSrcPath
		];
		
		// Для режима init добавляем обновление БД
		if (mode === 'init') {
			args.push('--updateDB');
		}
		
		// Выполняем oscript скрипт в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});
		
		// Формируем команду с экранированием аргументов
		const escapedArgs = args.map(arg => {
			// Если аргумент содержит пробелы, обрамляем кавычками
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			// Если аргумент пустой, передаём пустые кавычки
			if (arg === '') {
				return '""';
			}
			return arg;
		});
		
		const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
		
		terminal.sendText(command);
		terminal.show();
	}


	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * Использует OneScript скрипт с библиотекой v8runner
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * Использует OneScript скрипт с библиотекой v8runner
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * Использует OneScript скрипт с библиотекой v8runner
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * Использует универсальный CLI для v8runner
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * Использует универсальный CLI для v8runner
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * Использует универсальный CLI для v8runner и обновляет конфигурацию БД
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Фильтрует строки из Commit.txt, оставляя только те, которые относятся к основной конфигурации
	 * 
	 * Путь к файлу основной конфигурации должен содержать `src/cf/` и НЕ должен содержать `src/cfe/`.
	 * Пути могут быть относительными (от workspace root) или абсолютными.
	 * 
	 * @param commitPath - Путь к исходному файлу Commit.txt
	 * @param workspaceRoot - Корневая директория workspace
	 * @returns Путь к временному файлу с отфильтрованными строками
	 * @throws Ошибка, если не удалось прочитать исходный файл или создать временный файл
	 */
	private async filterCommitFileForBaseConfig(
		commitPath: string,
		workspaceRoot: string
	): Promise<string> {
		const fs = await import('node:fs/promises');
		
		// Читаем исходный файл Commit.txt
		let commitContent: string;
		try {
			commitContent = await fs.readFile(commitPath, 'utf-8');
		} catch (error) {
			throw new Error(`Не удалось прочитать файл Commit.txt: ${(error as Error).message}`);
		}

		// Разбиваем на строки
		const lines = commitContent.split(/\r?\n/);
		
		// Фильтруем строки, оставляя только те, которые относятся к основной конфигурации
		const filteredLines: string[] = [];
		const baseConfigPathPattern = 'src/cf/'.toLowerCase();
		const extensionPathPattern = 'src/cfe/'.toLowerCase();
		
		for (const line of lines) {
			// Пропускаем пустые строки и комментарии
			const trimmedLine = line.trim();
			if (trimmedLine === '' || trimmedLine.startsWith('REM')) {
				continue;
			}

			// Нормализуем путь для сравнения (заменяем обратные слэши на прямые, приводим к нижнему регистру)
			const normalizedLine = line.replace(/\\/g, '/').toLowerCase();
			
			// Проверяем, содержит ли путь src/cf/ и НЕ содержит src/cfe/
			if (normalizedLine.includes(baseConfigPathPattern) && !normalizedLine.includes(extensionPathPattern)) {
				filteredLines.push(line);
			}
		}

		// Создаем временный файл в папке build/commit/
		const buildCommitDir = path.join(workspaceRoot, 'build', 'commit');
		
		// Создаем папку, если её нет
		try {
			await fs.mkdir(buildCommitDir, { recursive: true });
		} catch (error) {
			throw new Error(`Не удалось создать папку build/commit: ${(error as Error).message}`);
		}

		const tempFileName = 'Commit_Base.txt';
		const tempFilePath = path.join(buildCommitDir, tempFileName);

		// Записываем отфильтрованные строки во временный файл
		try {
			await fs.writeFile(tempFilePath, filteredLines.join('\n'), 'utf-8');
		} catch (error) {
			throw new Error(`Не удалось создать временный файл ${tempFileName}: ${(error as Error).message}`);
		}

		return tempFilePath;
	}

	/**
	 * Обновляет конфигурацию из исходников с использованием файла Commit.txt
	 * Использует универсальный CLI для v8runner и обновляет конфигурацию БД
	 * 
	 * Перед выполнением команды создает временный файл Commit_Base.txt с отфильтрованными
	 * строками из Commit.txt (только пути к основной конфигурации, без расширений).
	 * После выполнения команды временный файл удаляется.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async updateFromSrcWithCommit(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const srcPath = this.vrunner.getSrcPath();
		const commitPath = this.vrunner.getCommitPath();
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getUpdateConfigurationFromSrcWithCommitCommandName();

		// Формируем абсолютные пути
		const absoluteSrcPath = path.isAbsolute(srcPath) 
			? srcPath 
			: path.join(workspaceRoot, srcPath);
		
		const absoluteCommitPath = path.isAbsolute(commitPath)
			? commitPath
			: path.join(workspaceRoot, commitPath);
		
		// Создаем временный файл с отфильтрованными строками для основной конфигурации
		let tempCommitPath: string;
		try {
			tempCommitPath = await this.filterCommitFileForBaseConfig(absoluteCommitPath, workspaceRoot);
		} catch (error) {
			vscode.window.showErrorMessage(`Ошибка при фильтрации Commit.txt: ${(error as Error).message}`);
			return;
		}

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		try {
			await fs.access(scriptPath);
		} catch {
			// Удаляем временный файл перед выходом
			try {
				await fs.unlink(tempCommitPath);
			} catch {
				// Игнорируем ошибку удаления
			}
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}
		
		// Получаем путь к oscript
		const onescriptPath = this.vrunner.getOnescriptPath();
		
		// Формируем команду для выполнения загрузки
		const args = [
			scriptPath,
			'loadConfigFromFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--src', absoluteSrcPath,
			'--listFile', tempCommitPath,
			'--updateDB'
		];
		
		// Формируем команду с экранированием аргументов
		const escapedArgs = args.map(arg => {
			// Если аргумент содержит пробелы, обрамляем кавычками
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			// Если аргумент пустой, передаём пустые кавычки
			if (arg === '') {
				return '""';
			}
			return arg;
		});
		
		const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
		
		// Определяем тип оболочки для правильного удаления файла
		const { detectShellType, joinCommands } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		
		// Формируем команду удаления временного файла
		// На Windows всегда используем PowerShell команду, так как VS Code по умолчанию использует PowerShell
		// Для Unix-систем используем rm
		let deleteCommand: string;
		if (process.platform === 'win32') {
			// На Windows всегда используем PowerShell команду для надежности
			deleteCommand = `Remove-Item -LiteralPath "${tempCommitPath}" -Force -ErrorAction SilentlyContinue`;
		} else {
			// Unix-системы (Linux, macOS)
			deleteCommand = `rm -f "${tempCommitPath}"`;
		}
		
		// Объединяем команды: сначала загрузка, затем удаление временного файла
		const combinedCommand = joinCommands([command, deleteCommand], shellType);
		
		// Выполняем команды в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});
		
		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Загружает конфигурацию из .cf файла в информационную базу
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Загружает конфигурацию из .cf файла в информационную базу
	 * 
	 * Использует v8runner-cli.os для загрузки конфигурации из файла .cf.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async loadFromCf(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const cfFilePath = path.join(workspaceRoot, buildPath, '1Cv8.cf');
		
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getLoadConfigurationFromCfCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}
		
		// Получаем путь к oscript
		const onescriptPath = this.vrunner.getOnescriptPath();
		
		// Аргументы для универсального CLI
		const args = [
			scriptPath,
			'loadCfg',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--file', cfFilePath
		];
		
		// Выполняем oscript скрипт в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});
		
		// Формируем команду с экранированием аргументов
		const escapedArgs = args.map(arg => {
			// Если аргумент содержит пробелы, обрамляем кавычками
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			// Если аргумент пустой, передаём пустые кавычки
			if (arg === '') {
				return '""';
			}
			return arg;
		});
		
		const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
		
		terminal.sendText(command);
		terminal.show();
	}

	/**
	 * Выгружает конфигурацию из информационной базы в исходники
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Выгружает конфигурацию из информационной базы в исходники
	 * 
	 * Использует v8runner-cli.os для выгрузки конфигурации в исходники.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpToSrc(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const srcPath = this.vrunner.getSrcPath();
		const absoluteSrcPath = path.isAbsolute(srcPath) 
			? srcPath 
			: path.join(workspaceRoot, srcPath);
		
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpConfigurationToSrcCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}
		
		// Получаем путь к oscript
		const onescriptPath = this.vrunner.getOnescriptPath();
		
		// Аргументы для универсального CLI с абсолютными путями
		const args = [
			scriptPath,
			'dumpConfigToFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--out', absoluteSrcPath
		];
		
		// Выполняем oscript скрипт в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});
		
		// Формируем команду с экранированием аргументов
		const escapedArgs = args.map(arg => {
			// Если аргумент содержит пробелы, обрамляем кавычками
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			// Если аргумент пустой, передаём пустые кавычки
			if (arg === '') {
				return '""';
			}
			return arg;
		});
		
		const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
		
		terminal.sendText(command);
		terminal.show();
	}


	/**
	 * Выгружает обновление конфигурации в исходники (только изменённые файлы)
	 * Использует универсальный CLI для v8runner
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpUpdateToSrc(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const srcPath = this.vrunner.getSrcPath();
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpUpdateConfigurationToSrcCommandName();
		
		// Формируем абсолютный путь
		const absoluteSrcPath = path.isAbsolute(srcPath) 
			? srcPath 
			: path.join(workspaceRoot, srcPath);
		
		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}
		
		// Аргументы для универсального CLI с абсолютными путями
		const args = [
			scriptPath,
			'dumpConfigToFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--out', absoluteSrcPath,
			'--update'
		];
		
		// Получаем путь к oscript
		const onescriptPath = this.vrunner.getOnescriptPath();
		
		// Выполняем oscript скрипт в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});
		
		// Формируем команду с экранированием аргументов
		const escapedArgs = args.map(arg => {
			// Если аргумент содержит пробелы, обрамляем кавычками
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			// Если аргумент пустой, передаём пустые кавычки
			if (arg === '') {
				return '""';
			}
			return arg;
		});
		
		const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
		
		terminal.sendText(command);
		terminal.show();
	}

	/**
	 * Выгружает конфигурацию из информационной базы в .cf файл
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Выгружает конфигурацию из информационной базы в файл .cf
	 * 
	 * Использует v8runner-cli.os для выгрузки конфигурации в файл .cf.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpToCf(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const outputPath = path.join(workspaceRoot, buildPath, '1Cv8.cf');
		
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpConfigurationToCfCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}
		
		// Получаем путь к oscript
		const onescriptPath = this.vrunner.getOnescriptPath();
		
		// Аргументы для универсального CLI
		const args = [
			scriptPath,
			'dumpCfg',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--file', outputPath
		];
		
		// Выполняем oscript скрипт в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});
		
		// Формируем команду с экранированием аргументов
		const escapedArgs = args.map(arg => {
			// Если аргумент содержит пробелы, обрамляем кавычками
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			// Если аргумент пустой, передаём пустые кавычки
			if (arg === '') {
				return '""';
			}
			return arg;
		});
		
		const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
		
		terminal.sendText(command);
		terminal.show();
	}

	/**
	 * Выгружает файл поставки в 1Cv8dist.cf
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpToDist(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const outputPath = path.join(buildPath, '1Cv8dist.cf');
		const args = ['make-dist', outputPath];
		const commandName = getDumpConfigurationToDistCommandName();

		this.vrunner.executeVRunnerInTerminal(args, {
			cwd: workspaceRoot,
			name: commandName.title
		});
	}

	/**
	 * Собирает .cf файл из исходников
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Собирает .cf файл из исходников
	 * 
	 * Использует v8runner-cli.os для сборки конфигурации: загружает из исходников, затем выгружает в .cf файл.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async compile(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const srcPath = this.vrunner.getSrcPath();
		const absoluteSrcPath = path.isAbsolute(srcPath) 
			? srcPath 
			: path.join(workspaceRoot, srcPath);
		
		const buildPath = this.vrunner.getBuildPath();
		const outputPath = path.join(workspaceRoot, buildPath, '1Cv8.cf');
		
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getBuildConfigurationCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}
		
		// Импортируем утилиты для работы с командами
		const { joinCommands, detectShellType } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		const onescriptPath = this.vrunner.getOnescriptPath();

		// Шаг 1: Загрузить конфигурацию из исходников
		const loadArgs = [
			scriptPath,
			'loadConfigFromFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--src', absoluteSrcPath
		];

		const escapedLoadArgs = loadArgs.map(arg => {
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			if (arg === '') {
				return '""';
			}
			return arg;
		});

		const loadCommand = `${onescriptPath} ${escapedLoadArgs.join(' ')}`;

		// Шаг 2: Выгрузить конфигурацию в файл .cf
		const dumpArgs = [
			scriptPath,
			'dumpCfg',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--file', outputPath
		];

		const escapedDumpArgs = dumpArgs.map(arg => {
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			if (arg === '') {
				return '""';
			}
			return arg;
		});

		const dumpCommand = `${onescriptPath} ${escapedDumpArgs.join(' ')}`;

		// Объединяем команды
		const combinedCommand = joinCommands([loadCommand, dumpCommand], shellType);

		// Выполняем команды в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Разбирает .cf файл в исходники
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Разбирает .cf файл в исходники
	 * 
	 * Использует v8runner-cli.os для разбора конфигурации: загружает из .cf файла, затем выгружает в исходники.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async decompile(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const inputPath = path.join(workspaceRoot, buildPath, '1Cv8.cf');
		const srcPath = this.vrunner.getSrcPath();
		const absoluteSrcPath = path.isAbsolute(srcPath) 
			? srcPath 
			: path.join(workspaceRoot, srcPath);
		
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDecompileConfigurationCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		try {
			await fs.access(scriptPath);
		} catch {
			vscode.window.showErrorMessage(
				'Не найден скрипт v8runner-cli.os в папке oscript_modules/v8runner/src/. Убедитесь, что библиотека v8runner установлена.'
			);
			return;
		}
		
		// Импортируем утилиты для работы с командами
		const { joinCommands, detectShellType } = await import('../utils/commandUtils.js');
		const shellType = detectShellType();
		const onescriptPath = this.vrunner.getOnescriptPath();

		// Шаг 1: Загрузить конфигурацию из файла .cf
		const loadArgs = [
			scriptPath,
			'loadCfg',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--file', inputPath
		];

		const escapedLoadArgs = loadArgs.map(arg => {
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			if (arg === '') {
				return '""';
			}
			return arg;
		});

		const loadCommand = `${onescriptPath} ${escapedLoadArgs.join(' ')}`;

		// Шаг 2: Выгрузить конфигурацию в исходники
		const dumpArgs = [
			scriptPath,
			'dumpConfigToFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--out', absoluteSrcPath
		];

		const escapedDumpArgs = dumpArgs.map(arg => {
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			if (arg === '') {
				return '""';
			}
			return arg;
		});

		const dumpCommand = `${onescriptPath} ${escapedDumpArgs.join(' ')}`;

		// Объединяем команды
		const combinedCommand = joinCommands([loadCommand, dumpCommand], shellType);

		// Выполняем команды в терминале
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}
}
