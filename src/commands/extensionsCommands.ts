import * as vscode from 'vscode';
import * as path from 'node:path';
import { BaseCommand } from './baseCommand';
import {
	getLoadExtensionFromSrcCommandName,
	getLoadExtensionFromCfeCommandName,
	getDumpExtensionToSrcCommandName,
	getDumpExtensionToCfeCommandName,
	getDumpUpdateExtensionToSrcCommandName,
	getUpdateExtensionFromSrcWithCommitCommandName,
	getBuildExtensionCommandName,
	getDecompileExtensionCommandName
} from '../commandNames';

/**
 * Команды для работы с расширениями конфигурации
 * 
 * Предоставляет методы для загрузки, выгрузки, сборки и разбора расширений конфигурации 1С
 */
export class ExtensionsCommands extends BaseCommand {

	/**
	 * Получает список папок расширений из исходников
	 * 
	 * Расширение 1С определяется по наличию файла Configuration.xml в корне папки.
	 * Метод фильтрует все директории, оставляя только те, которые содержат этот файл.
	 * 
	 * @param workspaceRoot - Корневая директория workspace
	 * @returns Промис, который разрешается массивом имен папок расширений или undefined при ошибке
	 */
	/**
	 * Фильтрует строки из Commit.txt, оставляя только те, которые относятся к указанному расширению
	 * 
	 * Путь к файлу расширения должен содержать подстроку `src/cfe/<ИмяРасширения>/`.
	 * Пути могут быть относительными (от workspace root) или абсолютными.
	 * 
	 * @param commitPath - Путь к исходному файлу Commit.txt
	 * @param extensionName - Имя расширения
	 * @param workspaceRoot - Корневая директория workspace
	 * @returns Путь к временному файлу с отфильтрованными строками
	 * @throws Ошибка, если не удалось прочитать исходный файл или создать временный файл
	 */
	private async filterCommitFileByExtension(
		commitPath: string,
		extensionName: string,
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
		
		// Фильтруем строки, оставляя только те, которые относятся к указанному расширению
		const filteredLines: string[] = [];
		const extensionPathPattern = `src/cfe/${extensionName}/`.toLowerCase();
		
		for (const line of lines) {
			// Пропускаем пустые строки и комментарии
			const trimmedLine = line.trim();
			if (trimmedLine === '' || trimmedLine.startsWith('REM')) {
				continue;
			}

			// Нормализуем путь для сравнения (заменяем обратные слэши на прямые, приводим к нижнему регистру)
			const normalizedLine = line.replace(/\\/g, '/').toLowerCase();
			
			// Проверяем, содержит ли путь подстроку для расширения
			if (normalizedLine.includes(extensionPathPattern)) {
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

		const tempFileName = `Commit_${extensionName}.txt`;
		const tempFilePath = path.join(buildCommitDir, tempFileName);

		// Записываем отфильтрованные строки во временный файл
		try {
			await fs.writeFile(tempFilePath, filteredLines.join('\n'), 'utf-8');
		} catch (error) {
			throw new Error(`Не удалось создать временный файл ${tempFileName}: ${(error as Error).message}`);
		}

		return tempFilePath;
	}

	private async getExtensionFoldersFromSrc(workspaceRoot: string): Promise<string[] | undefined> {
		const cfePath = this.vrunner.getCfePath();
		const extensionsSrcPath = path.join(workspaceRoot, cfePath);

		if (!(await this.checkDirectoryExists(extensionsSrcPath, `Папка ${cfePath} не является директорией`))) {
			return undefined;
		}

		// Получаем все директории в папке расширений
		const allDirectories = await this.getDirectories(extensionsSrcPath, `Ошибка при чтении папки ${cfePath}`);
		if (allDirectories.length === 0) {
			vscode.window.showInformationMessage(`В папке ${cfePath} не найдено расширений`);
			return undefined;
		}

		// Фильтруем: оставляем только папки, которые содержат Configuration.xml
		// Это признак того, что папка является расширением, а не подпапкой внутри расширения
		const extensionFolders: string[] = [];
		const fs = await import('node:fs/promises');

		for (const dir of allDirectories) {
			const dirPath = path.join(extensionsSrcPath, dir);
			const configXmlPath = path.join(dirPath, 'Configuration.xml');
			
			try {
				await fs.access(configXmlPath);
				// Файл Configuration.xml существует - это расширение
				extensionFolders.push(dir);
			} catch {
				// Файл не найден - это не расширение, пропускаем
				continue;
			}
		}

		if (extensionFolders.length === 0) {
			vscode.window.showInformationMessage(`В папке ${cfePath} не найдено расширений (папки с файлом Configuration.xml)`);
			return undefined;
		}

		return extensionFolders;
	}

	/**
	 * Загружает расширения из исходников в информационную базу
	 * 
	 * Находит все подпапки в папке расширений и для каждой выполняет команду `compileext`.
	 * Расширения загружаются в информационную базу, указанную в параметрах подключения.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Загружает расширения из исходников в информационную базу
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и загружает их
	 * через v8runner-cli.os. Использует параметр -AllExtensions для загрузки всех расширений
	 * одним вызовом.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Загружает расширения из исходников в информационную базу
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду загрузки через v8runner-cli.os. Каждое расширение загружается из
	 * своего каталога (например, src/cfe/IBS или src/cfe/MOD).
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async loadFromSrc(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const extensionFolders = await this.getExtensionFoldersFromSrc(workspaceRoot);
		if (!extensionFolders) {
			return;
		}

		const cfePath = this.vrunner.getCfePath();
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getLoadExtensionFromSrcCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
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

		// Формируем команды для всех расширений
		const commands: string[] = [];

		for (const extensionFolder of extensionFolders) {
			// Формируем абсолютный путь к каталогу конкретного расширения
			const extensionSrcPath = path.isAbsolute(cfePath) 
				? path.join(cfePath, extensionFolder)
				: path.join(workspaceRoot, cfePath, extensionFolder);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'loadExtensionFromFiles',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--src', extensionSrcPath,
				'--extension', extensionFolder
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Загружает расширения из .cfe файлов в информационную базу
	 * 
	 * Находит все файлы .cfe в папке сборки (build/cfe) и для каждого выполняет команду загрузки
	 * через EPF обработку vanessa-runner. Имена файлов .cfe должны соответствовать именам расширений
	 * (например, Расширение1.cfe для расширения "Расширение1").
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Загружает расширения из .cfe файлов в информационную базу
	 * 
	 * Находит все файлы .cfe в папке сборки (build/cfe) и для каждого выполняет команду загрузки
	 * через v8runner-cli.os. Имена файлов .cfe должны соответствовать именам расширений
	 * (например, Расширение1.cfe для расширения "Расширение1").
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async loadFromCfe(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const cfePath = path.join(workspaceRoot, buildPath, 'cfe');

		if (!(await this.checkDirectoryExists(cfePath, `Папка ${buildPath}/cfe не является директорией`))) {
			return;
		}

		const cfeFiles = await this.getFilesByExtension(cfePath, '.cfe', `Ошибка при чтении папки ${buildPath}/cfe`);
		if (cfeFiles.length === 0) {
			vscode.window.showInformationMessage(`В папке ${buildPath}/cfe не найдено файлов .cfe`);
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getLoadExtensionFromCfeCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
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

		// Формируем команды для всех .cfe файлов
		const commands: string[] = [];

		for (const cfeFile of cfeFiles) {
			// Извлекаем имя расширения из имени файла (убираем расширение .cfe)
			const extensionName = cfeFile.replace(/\.cfe$/i, '');
			const cfeFilePath = path.join(cfePath, cfeFile);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'loadExtensionFromFile',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--file', cfeFilePath,
				'--extension', extensionName
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Выгружает расширения из информационной базы в исходники
	 * 
	 * Использует команду конфигуратора /DumpConfigToFiles с параметром -AllExtensions
	 * для автоматической выгрузки всех расширений из конфигурации 1С в отдельные каталоги.
	 * Каждое расширение выгружается в каталог со своим именем в папке src/cfe.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Выгружает расширения из информационной базы в исходники
	 * 
	 * Использует команду конфигуратора /DumpConfigToFiles с параметром -AllExtensions
	 * для автоматической выгрузки всех расширений из конфигурации 1С в отдельные каталоги.
	 * Каждое расширение выгружается в каталог со своим именем в папке src/cfe.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpToSrc(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpExtensionToSrcCommandName();
		const cfePath = this.vrunner.getCfePath();
		
		// Формируем абсолютный путь к каталогу выгрузки
		const absoluteCfePath = path.isAbsolute(cfePath) 
			? cfePath 
			: path.join(workspaceRoot, cfePath);
		
		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
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
			'dumpExtensionToFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--out', absoluteCfePath,
			'--extension', '-AllExtensions'
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
	 * Выгружает обновление расширений из информационной базы в исходники
	 * 
	 * Использует команду конфигуратора /DumpConfigToFiles с параметрами -AllExtensions и -update
	 * для автоматической выгрузки только измененных файлов всех расширений из конфигурации 1С
	 * в отдельные каталоги. Каждое расширение выгружается в каталог со своим именем в папке src/cfe.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	/**
	 * Выгружает обновление расширений из информационной базы в исходники
	 * 
	 * Использует команду конфигуратора /DumpConfigToFiles с параметрами -AllExtensions и -update
	 * для автоматической выгрузки только измененных файлов всех расширений из конфигурации 1С
	 * в отдельные каталоги. Каждое расширение выгружается в каталог со своим именем в папке src/cfe.
	 * 
	 * @returns Промис, который разрешается после запуска команды
	 */
	async dumpUpdateToSrc(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpUpdateExtensionToSrcCommandName();
		const cfePath = this.vrunner.getCfePath();
		
		// Формируем абсолютный путь к каталогу выгрузки
		const absoluteCfePath = path.isAbsolute(cfePath) 
			? cfePath 
			: path.join(workspaceRoot, cfePath);
		
		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
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
		// Используем dumpExtensionToFiles с -AllExtensions для выгрузки всех расширений в отдельные каталоги
		const args = [
			scriptPath,
			'dumpExtensionToFiles',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password,
			'--out', absoluteCfePath,
			'--extension', '-AllExtensions',
			'--update'
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
	 * Обновляет расширения из исходников с использованием файла Commit.txt
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой:
	 * 1. Создает временный файл Commit_<ИмяРасширения>.txt с отфильтрованными строками из Commit.txt
	 * 2. Выполняет команду загрузки расширения через vrunner run --command
	 * 3. Удаляет временный файл
	 * 
	 * После загрузки всех расширений выполняет обновление конфигурации БД через v8runner-cli.os.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Обновляет расширения из исходников с использованием файла Commit.txt
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой:
	 * 1. Создает временный файл Commit_<ИмяРасширения>.txt с отфильтрованными строками из Commit.txt
	 * 2. Выполняет команду загрузки расширения через v8runner-cli.os
	 * 3. Удаляет временный файл
	 * 
	 * После загрузки всех расширений выполняет обновление конфигурации БД через v8runner-cli.os.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async updateFromSrcWithCommit(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const extensionFolders = await this.getExtensionFoldersFromSrc(workspaceRoot);
		if (!extensionFolders) {
			return;
		}

		const commitPath = this.vrunner.getCommitPath();
		const absoluteCommitPath = path.isAbsolute(commitPath)
			? commitPath
			: path.join(workspaceRoot, commitPath);
		
		const cfePath = this.vrunner.getCfePath();
		const absoluteCfePath = path.isAbsolute(cfePath) 
			? cfePath 
			: path.join(workspaceRoot, cfePath);
		
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getUpdateExtensionFromSrcWithCommitCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
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

		// Формируем команды для всех расширений
		const commands: string[] = [];
		const tempFiles: string[] = [];

		for (const extensionFolder of extensionFolders) {
			// Создаем временный файл с отфильтрованными строками для расширения
			let tempCommitPath: string;
			try {
				tempCommitPath = await this.filterCommitFileByExtension(
					absoluteCommitPath,
					extensionFolder,
					workspaceRoot
				);
				tempFiles.push(tempCommitPath);
			} catch (error) {
				vscode.window.showErrorMessage(
					`Ошибка при фильтрации Commit.txt для расширения ${extensionFolder}: ${(error as Error).message}`
				);
				// Удаляем уже созданные временные файлы
				for (const tempFile of tempFiles) {
					try {
						await fs.unlink(tempFile);
					} catch {
						// Игнорируем ошибку удаления
					}
				}
				return;
			}

			// Формируем абсолютный путь к каталогу конкретного расширения
			const extensionSrcPath = path.isAbsolute(cfePath) 
				? path.join(cfePath, extensionFolder)
				: path.join(workspaceRoot, cfePath, extensionFolder);

			// Формируем команду загрузки расширения через v8runner-cli.os
			const args = [
				scriptPath,
				'loadExtensionFromFiles',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--src', extensionSrcPath,
				'--extension', extensionFolder,
				'--listFile', tempCommitPath
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);

			// Добавляем команду удаления временного файла после загрузки
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
			commands.push(deleteCommand);
		}

		// После загрузки всех расширений выполняем обновление конфигурации БД
		const updateDbArgs = [
			scriptPath,
			'updateDB',
			'--ibconnection', ibParams.connection,
			'--db-user', ibParams.username,
			'--db-pwd', ibParams.password
		];

		const escapedUpdateDbArgs = updateDbArgs.map(arg => {
			if (arg.includes(' ')) {
				return `"${arg}"`;
			}
			if (arg === '') {
				return '""';
			}
			return arg;
		});

		const updateDbCommand = `${onescriptPath} ${escapedUpdateDbArgs.join(' ')}`;
		commands.push(updateDbCommand);

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Выгружает расширения из информационной базы в .cfe файлы
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду `unloadext`. Расширения выгружаются из информационной базы в бинарные
	 * .cfe файлы в папку сборки (build/cfe). Имя файла соответствует имени расширения.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Выгружает расширения в .cfe файлы
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду выгрузки через v8runner-cli.os. Каждое расширение выгружается
	 * в отдельный .cfe файл в папке сборки (build/cfe). Имя файла соответствует имени расширения.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async dumpToCfe(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const extensionFolders = await this.getExtensionFoldersFromSrc(workspaceRoot);
		if (!extensionFolders) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDumpExtensionToCfeCommandName();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
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

		// Создаем каталог для .cfe файлов, если его нет
		const cfeOutputDir = path.join(workspaceRoot, buildPath, 'cfe');
		try {
			await fs.mkdir(cfeOutputDir, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(
				`Ошибка при создании папки ${buildPath}/cfe: ${(error as Error).message}`
			);
			return;
		}

		// Формируем команды для всех расширений
		const commands: string[] = [];

		for (const extensionFolder of extensionFolders) {
			const extensionFileName = `${extensionFolder}.cfe`;
			const cfeFilePath = path.join(workspaceRoot, buildPath, 'cfe', extensionFileName);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'dumpExtensionToFile',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--file', cfeFilePath,
				'--extension', extensionFolder
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Собирает .cfe файл из исходников
	 * 
	 * Находит все подпапки в папке расширений и для каждой выполняет команду `compileexttocfe`.
	 * Исходники расширений компилируются в бинарные .cfe файлы в папку сборки.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Собирает .cfe файлы из исходников расширений
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду `compileexttocfe`. Исходники расширений компилируются в бинарные
	 * .cfe файлы в папку сборки (build/cfe). Имя файла соответствует имени расширения.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Собирает .cfe файлы из исходников расширений
	 * 
	 * Находит все папки расширений в src/cfe (содержащие Configuration.xml) и для каждой
	 * выполняет команду сборки через v8runner-cli.os. Исходники расширений компилируются в бинарные
	 * .cfe файлы в папку сборки (build/cfe). Имя файла соответствует имени расширения.
	 * Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async compile(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const extensionFolders = await this.getExtensionFoldersFromSrc(workspaceRoot);
		if (!extensionFolders) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getBuildExtensionCommandName();
		const cfePath = this.vrunner.getCfePath();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
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

		// Создаем каталог для .cfe файлов, если его нет
		const cfeOutputDir = path.join(workspaceRoot, buildPath, 'cfe');
		try {
			await fs.mkdir(cfeOutputDir, { recursive: true });
		} catch (error) {
			vscode.window.showErrorMessage(
				`Ошибка при создании папки ${buildPath}/cfe: ${(error as Error).message}`
			);
			return;
		}

		// Формируем команды для всех расширений
		const commands: string[] = [];

		for (const extensionFolder of extensionFolders) {
			const extensionFileName = `${extensionFolder}.cfe`;
			const srcPath = path.isAbsolute(cfePath) 
				? path.join(cfePath, extensionFolder)
				: path.join(workspaceRoot, cfePath, extensionFolder);
			const outPath = path.join(workspaceRoot, buildPath, 'cfe', extensionFileName);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'compileExtensionToCfe',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--src', srcPath,
				'--out', outPath,
				'--extension', extensionFolder
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}

	/**
	 * Разбирает .cfe файлы в исходники расширений
	 * 
	 * Находит все файлы .cfe в папке сборки (build/cfe) и для каждого выполняет команду `decompileext`.
	 * Бинарные .cfe файлы разбираются в исходники в формате XML в папку расширений (src/cfe).
	 * Имя расширения извлекается из имени файла (без расширения .cfe), и исходники выгружаются
	 * в папку с этим именем. Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	/**
	 * Разбирает .cfe файлы в исходники расширений
	 * 
	 * Находит все файлы .cfe в папке сборки (build/cfe) и для каждого выполняет команду разбора
	 * через v8runner-cli.os. Бинарные .cfe файлы разбираются в исходники в формате XML в папку расширений (src/cfe).
	 * Имя расширения извлекается из имени файла (без расширения .cfe), и исходники выгружаются
	 * в папку с этим именем. Все команды выполняются последовательно в одном терминале.
	 * 
	 * @returns Промис, который разрешается после запуска команд
	 */
	async decompile(): Promise<void> {
		const workspaceRoot = this.ensureWorkspace();
		if (!workspaceRoot) {
			return;
		}

		const buildPath = this.vrunner.getBuildPath();
		const cfeBuildPath = path.join(workspaceRoot, buildPath, 'cfe');

		if (!(await this.checkDirectoryExists(cfeBuildPath, `Папка ${buildPath}/cfe не является директорией`))) {
			return;
		}

		const cfeFiles = await this.getFilesByExtension(cfeBuildPath, '.cfe', `Ошибка при чтении папки ${buildPath}/cfe`);
		if (cfeFiles.length === 0) {
			vscode.window.showInformationMessage(`В папке ${buildPath}/cfe не найдено файлов .cfe`);
			return;
		}

		const ibParams = await this.vrunner.getIbConnectionParams();
		const commandName = getDecompileExtensionCommandName();
		const cfePath = this.vrunner.getCfePath();

		// Путь к универсальному CLI скрипту v8runner
		const scriptPath = path.join(workspaceRoot, 'oscript_modules', 'v8runner', 'src', 'v8runner-cli.os');
		
		// Проверка существования скрипта
		const fs = await import('node:fs/promises');
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

		// Формируем команды для всех .cfe файлов
		const commands: string[] = [];

		for (const cfeFile of cfeFiles) {
			const extensionName = cfeFile.replace(/\.cfe$/i, '');
			const cfeFilePath = path.join(cfeBuildPath, cfeFile);
			const outputPath = path.isAbsolute(cfePath) 
				? path.join(cfePath, extensionName)
				: path.join(workspaceRoot, cfePath, extensionName);
			
			// Аргументы для универсального CLI
			const args = [
				scriptPath,
				'decompileExtension',
				'--ibconnection', ibParams.connection,
				'--db-user', ibParams.username,
				'--db-pwd', ibParams.password,
				'--file', cfeFilePath,
				'--out', outputPath,
				'--extension', extensionName
			];

			// Формируем команду с экранированием аргументов
			const escapedArgs = args.map(arg => {
				if (arg.includes(' ')) {
					return `"${arg}"`;
				}
				if (arg === '') {
					return '""';
				}
				return arg;
			});

			const command = `${onescriptPath} ${escapedArgs.join(' ')}`;
			commands.push(command);
		}

		// Удаляем префиксы кодировки из всех команд кроме первой
		let encodingPrefix = '';
		if (shellType === 'powershell') {
			encodingPrefix = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ';
		} else if (shellType === 'cmd') {
			encodingPrefix = 'chcp 65001 >nul && ';
		}
		
		const cleanedCommands = commands.map((cmd, index) => {
			if (index === 0) {
				return cmd; // Первая команда с префиксом
			}
			// Удаляем префикс кодировки из остальных команд
			return cmd.replace(encodingPrefix, '');
		});

		// Объединяем все команды в одну строку с правильными разделителями
		const combinedCommand = joinCommands(cleanedCommands, shellType);

		// Создаем один терминал и отправляем все команды
		const terminal = vscode.window.createTerminal({
			name: commandName.title,
			cwd: workspaceRoot
		});

		terminal.sendText(combinedCommand);
		terminal.show();
	}
}
