/**
 * Класс References управляет уникальными идентификаторами для фреймов и переменных в DAP.
 * Используется в scopesRequest и variablesRequest для связи DAP ID с внутренними данными.
 */

export class References {
	private nextId = 1;
	private frames = new Map<number, { threadId: number; frameIndex: number }>();
	private variables = new Map<number, { path: string; value: unknown }>();

	/**
	 * Регистрирует фрейм стека и возвращает уникальный ID для DAP.
	 * @param threadId - идентификатор потока
	 * @param frameIndex - индекс фрейма в стеке вызовов
	 * @returns уникальный ID фрейма
	 */
	registerFrame(threadId: number, frameIndex: number): number {
		const id = this.nextId++;
		this.frames.set(id, { threadId, frameIndex });
		return id;
	}

	/**
	 * Регистрирует переменную и возвращает уникальный variablesReference для DAP.
	 * @param path - путь к переменной (например, "locals", "globals")
	 * @param value - значение переменной
	 * @returns уникальный variablesReference
	 */
	registerVariable(path: string, value: unknown): number {
		const id = this.nextId++;
		this.variables.set(id, { path, value });
		return id;
	}

	/**
	 * Получает информацию о фрейме по ID.
	 * @param id - ID фрейма
	 * @returns данные фрейма или undefined
	 */
	getFrame(id: number): { threadId: number; frameIndex: number } | undefined {
		return this.frames.get(id);
	}

	/**
	 * Получает информацию о переменной по variablesReference.
	 * @param id - variablesReference
	 * @returns данные переменной или undefined
	 */
	getVariable(id: number): { path: string; value: unknown } | undefined {
		return this.variables.get(id);
	}

	/**
	 * Очищает все зарегистрированные фреймы и переменные.
	 * Вызывается при disconnect или новой остановке.
	 */
	clear(): void {
		this.frames.clear();
		this.variables.clear();
		this.nextId = 1;
	}
}
