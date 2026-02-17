/**
 * Точка входа отладчика 1C: регистрация DebugAdapterDescriptorFactory
 * и DebugConfigurationProvider.
 */

import * as vscode from 'vscode';
import { OnecDebugSession } from './debugSession';
import { OnecDebugConfigurationProvider } from './debugConfiguration';

/**
 * Регистрирует фабрику адаптера отладки и провайдер конфигурации для типа "onec".
 */
export function registerDebugAdapter(context: vscode.ExtensionContext): void {
	const factory = new (class implements vscode.DebugAdapterDescriptorFactory {
		createDebugAdapterDescriptor(
			_session: vscode.DebugSession,
			_executable: vscode.DebugAdapterExecutable | undefined,
		): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
			return new vscode.DebugAdapterInlineImplementation(new OnecDebugSession());
		}
	})();

	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory('onec', factory),
		vscode.debug.registerDebugConfigurationProvider('onec', new OnecDebugConfigurationProvider()),
	);
}
