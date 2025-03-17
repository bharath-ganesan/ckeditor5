#!/usr/bin/env node

/**
 * @license Copyright (c) 2003-2025, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-licensing-options
 */

/* eslint-env node */

import upath from 'upath';
import fs from 'fs-extra';
import { EventEmitter } from 'events';
import * as releaseTools from '@ckeditor/ckeditor5-dev-release-tools';
import { tools } from '@ckeditor/ckeditor5-dev-utils';
import { Listr } from 'listr2';

import buildPackageUsingRollupCallback from './utils/buildpackageusingrollupcallback.mjs';
import getCKEditor5PackageJson from './utils/getckeditor5packagejson.mjs';
import parseArguments from './utils/parsearguments.mjs';
import compileTypeScriptCallback from './utils/compiletypescriptcallback.mjs';
import updatePackageEntryPoint from './utils/updatepackageentrypoint.mjs';
import getListrOptions from './utils/getlistroptions.mjs';
import getReleaseDescription from './utils/getreleasedescription.mjs';
import {
	PACKAGES_DIRECTORY,
	RELEASE_DIRECTORY,
	RELEASE_NPM_DIRECTORY
} from './utils/constants.mjs';

const cliArguments = parseArguments( process.argv.slice( 2 ) );
const [ latestVersion ] = await getReleaseDescription( cliArguments );
const taskOptions = {
	rendererOptions: {
		collapseSubtasks: false
	}
};

// The number of `executeInParallel()` executions.
EventEmitter.defaultMaxListeners = ( cliArguments.concurrency * 5 + 1 );

const tasks = new Listr( [
	{
		title: 'Removing dist folder.',
		task: () => {
			return tools.shExec( 'yarn run remove:dist', { async: true, verbosity: 'silent' } );
		}
	},
	{
		title: 'Preparation phase.',
		task: ( ctx, task ) => {
			return task.newListr( [
				{
					title: 'Removing release folder.',
					task: () => {
						return tools.shExec( 'yarn run remove:release-folder', { async: true, verbosity: 'silent' } );
					}
				}
			], taskOptions );
		},
		skip: () => {
			// When compiling the packages only, do not update any values.
			if ( cliArguments.compileOnly ) {
				return true;
			}
			return false;
		}
	},
	{
		title: 'Compilation phase.',
		task: ( ctx, task ) => {
			return task.newListr( [
				{
					title: 'Compiling TypeScript in `ckeditor5-*` packages.',
					task: ( ctx, task ) => {
						return releaseTools.executeInParallel( {
							packagesDirectory: PACKAGES_DIRECTORY,
							listrTask: task,
							taskToExecute: compileTypeScriptCallback,
							concurrency: cliArguments.concurrency
						} );
					}
				},
				{
					title: 'Building the `dist/` directory for `ckeditor5-*` packages.',
					task: ( ctx, task ) => {
						return releaseTools.executeInParallel( {
							packagesDirectory: PACKAGES_DIRECTORY,
							listrTask: task,
							taskToExecute: buildPackageUsingRollupCallback,
							concurrency: cliArguments.concurrency
						} );
					}
				},
				{
					title: 'Copying CKEditor 5 packages to the release directory.',
					task: () => {
						return releaseTools.prepareRepository( {
							outputDirectory: RELEASE_DIRECTORY,
							packagesDirectory: PACKAGES_DIRECTORY,
							rootPackageJson: getCKEditor5PackageJson(),
							packagesToCopy: cliArguments.packages
						} );
					}
				},
				{
					title: 'Updating entries in `package.json`.',
					task: ( ctx, task ) => {
						return releaseTools.executeInParallel( {
							packagesDirectory: RELEASE_DIRECTORY,
							listrTask: task,
							taskToExecute: updatePackageEntryPoint,
							concurrency: cliArguments.concurrency
						} );
					}
				},
				{
					title: 'Moving packages to npm release directory.',
					task: async () => {
						const movePromises = ( await fs.readdir( RELEASE_DIRECTORY ) )
							.filter( packageSlug => packageSlug.startsWith( 'ckeditor5' ) )
							.map( packageSlug => {
								return fs.move(
									upath.join( RELEASE_DIRECTORY, packageSlug ),
									upath.join( RELEASE_NPM_DIRECTORY, packageSlug )
								);
							} );

						return Promise.all( movePromises );
					}
				},
				{
					title: 'Copying entry file to dist.',
					task: () => {
						return tools.shExec( 'yarn run copy:entry-file', { async: true, verbosity: 'silent' } );
					}
				},
				{
					title: 'Removing release folder.',
					task: () => {
						return tools.shExec( 'yarn run remove:release-folder', { async: true, verbosity: 'silent' } );
					}
				}
			], taskOptions );
		}
	},
	{
		title: 'Clean up phase.',
		task: ( ctx, task ) => {
			return task.newListr( [
				{
					title: 'Removing files that will not be published to npm.',
					task: () => {
						return releaseTools.cleanUpPackages( {
							packagesDirectory: RELEASE_NPM_DIRECTORY,
							packageJsonFieldsToRemove: defaults => [ ...defaults, 'engines' ]
						} );
					}
				},
				{
					title: 'Removing local typings.',
					task: () => {
						return tools.shExec( 'yarn run release:clean', { async: true, verbosity: 'silent' } );
					}
				}
			], taskOptions );
		}
	}
], getListrOptions( cliArguments ) );

console.log( 'Version', latestVersion );

tasks.run()
	.catch( err => {
		process.exitCode = 1;

		console.error( err );
	} );
