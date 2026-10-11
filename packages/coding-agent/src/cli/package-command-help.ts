/** Usage and help text for the package commands (moved out of package-manager-cli.ts). */
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import type { PackageCommand } from "./package-commands.ts";

export function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--allow-scripts]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source|self|omk] [--self] [--extensions] [--extension <source>] [--force] [--allow-scripts]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

export function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local        Install project-locally (.omk/settings.json)
  --allow-scripts    Run the package's install scripts (off by default; needed by native builds)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local    Remove from project settings (.omk/settings.json)

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update OMK and installed packages.

Options:
  --self                  Update OMK only
  --extensions            Update installed packages only
  --extension <source>    Update one package only
  --force                 Reinstall OMK even if the current version is latest
  --allow-scripts         Run package install scripts (off by default; needed by native builds)

Short forms:
  ${APP_NAME} update                Update OMK and all extensions
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update omk            Update OMK only (self works as alias to omk)
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}
