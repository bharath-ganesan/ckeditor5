/**
 * @license Copyright (c) 2003-2025, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-licensing-options
 */

/* eslint-env node */

import upath from 'upath';
import fs from 'fs';
import module from 'module';
import { fileURLToPath } from 'url';
import minimatch from 'minimatch';
import webpack from 'webpack';
import { bundler, loaders, tools } from '@ckeditor/ckeditor5-dev-utils';
import { CKEditorTranslationsPlugin } from '@ckeditor/ckeditor5-dev-translations';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import { globSync } from 'glob';
import { addTypeScriptLoader } from './utils.mjs';
import { CKEDITOR5_ROOT_PATH } from '../constants.mjs';

const __filename = fileURLToPath( import.meta.url );
const __dirname = upath.dirname( __filename );
const require = module.createRequire( import.meta.url );

const DEFAULT_LANGUAGE = 'en';
const MULTI_LANGUAGE = 'multi-language';
const SNIPPETS_BUILD_CHUNK_SIZE = 50;

const CLOUD_SERVICES_CONFIG_PATH = upath.join(
	CKEDITOR5_ROOT_PATH, 'packages', 'ckeditor5-cloud-services', 'tests', '_utils', 'cloud-services-config'
);

const CKBOX_CONFIG_PATH = upath.join(
	CKEDITOR5_ROOT_PATH, 'packages', 'ckeditor5-ckbox', 'tests', '_utils', 'ckbox-config'
);

const ARTICLE_PLUGIN_PATH = upath.join(
	CKEDITOR5_ROOT_PATH, 'packages', 'ckeditor5-core', 'tests', '_utils', 'articlepluginset.js'
);

// CKEditor 5 snippets require files and modules from directories that are not published on npm.
// While webpack does not complain when building docs locally, it reports errors related to importing non-existing files
// when building the nightly/production docs.
// Hence, we create a map that translates imports from the non-published directories to sources in the `packages/*` directory.
const RESOLVE_ALIAS_MAP = {
	// Import icons that are not a part of the package, but used only in the documentation.
	'@ckeditor/ckeditor5-image/docs/assets': upath.join( CKEDITOR5_ROOT_PATH, 'packages', 'ckeditor5-image', 'docs', 'assets' ),

	// The `ArticlePluginSet` that loads a simple article plugins.
	'@ckeditor/ckeditor5-core/tests/_utils/articlepluginset': ARTICLE_PLUGIN_PATH,
	'@ckeditor/ckeditor5-core/tests/_utils/articlepluginset.js': ARTICLE_PLUGIN_PATH,

	// Configuration for the Cloud Services used.
	'@ckeditor/ckeditor5-cloud-services/tests/_utils/cloud-services-config': CLOUD_SERVICES_CONFIG_PATH,
	'@ckeditor/ckeditor5-cloud-services/tests/_utils/cloud-services-config.js': CLOUD_SERVICES_CONFIG_PATH,

	// Configuration for the CKBox service.
	'@ckeditor/ckeditor5-ckbox/tests/_utils/ckbox-config.js': CKBOX_CONFIG_PATH,
	'@ckeditor/ckeditor5-ckbox/tests/_utils/ckbox-config': CKBOX_CONFIG_PATH
};

/**
 * @param {Set.<Snippet>} snippets Snippet collection extracted from documentation files.
 * @param {Object} options
 * @param {Boolean} options.production Whether to build snippets in production mode.
 * @param {Array.<String>|undefined} options.allowedSnippets An array that contains glob patterns of snippets that should be built.
 * If not specified or if passed the empty array, all snippets will be built.
 * @param {Object.<String, Function>} umbertoHelpers
 * @param {Object.<String, Function>} umbertoHelpers
 * @returns {Promise}
 */
export default async function snippetAdapter( snippets, options, umbertoHelpers ) {
	const { getSnippetPlaceholder, getSnippetSourcePaths } = umbertoHelpers;
	const snippetsDependencies = new Map();

	// For each snippet, load its config. If the snippet has defined dependencies, load those as well.
	for ( const snippetData of snippets ) {
		if ( !snippetData.snippetSources.js ) {
			throw new Error( `Missing snippet source for "${ snippetData.snippetName }".` );
		}

		snippetData.snippetConfig = readSnippetConfig( snippetData.snippetSources.js );
		snippetData.snippetConfig.language = snippetData.snippetConfig.language || DEFAULT_LANGUAGE;

		// If, in order to work, a snippet requires another snippet to be built, and the other snippet
		// isn't included in any guide via `{@snippet ...}`, then that other snippet need to be marked
		// as a dependency of the first one. Example – bootstrap UI uses an iframe, and inside that iframe we
		// need a JS file. That JS file needs to be built, even though it's not a real snippet (and it's not used
		// via {@snippet}).
		if ( snippetData.snippetConfig.dependencies ) {
			for ( const dependencyName of snippetData.snippetConfig.dependencies ) {
				// Do not load the same dependency more than once.
				if ( snippetsDependencies.has( dependencyName ) ) {
					continue;
				}

				// Find a root path where to look for the snippet's sources. We just want to pass it through Webpack.
				const snippetBasePathRegExp = new RegExp( snippetData.snippetName.replace( /\//g, '\\/' ) + '.*$' );
				const snippetBasePath = snippetData.snippetSources.js.replace( snippetBasePathRegExp, '' );

				const dependencySnippet = {
					snippetSources: getSnippetSourcePaths( snippetBasePath, dependencyName ),
					snippetName: dependencyName,
					outputPath: snippetData.outputPath,
					destinationPath: snippetData.destinationPath,
					requiredFor: snippetData
				};

				if ( !dependencySnippet.snippetSources.js ) {
					throw new Error( `Missing snippet source for "${ dependencySnippet.snippetName }".` );
				}

				dependencySnippet.snippetConfig = readSnippetConfig( dependencySnippet.snippetSources.js );
				dependencySnippet.snippetConfig.language = dependencySnippet.snippetConfig.language || DEFAULT_LANGUAGE;

				snippetsDependencies.set( dependencyName, dependencySnippet );
			}
		}
	}

	// Add all dependencies to the snippet collection.
	for ( const snippetData of snippetsDependencies.values() ) {
		snippets.add( snippetData );
	}

	// Remove snippets that do not match to patterns specified in `options.allowedSnippets`.
	if ( options.allowedSnippets && options.allowedSnippets.length ) {
		filterAllowedSnippets( snippets, options.allowedSnippets );
		console.log( `Found ${ snippets.size } matching {@snippet} tags.` );
	}

	console.log( 'Preparing to build snippets...' );

	const groupedSnippetsByLanguage = {};

	const constantDefinitions = await getConstantDefinitions( snippets );

	// Group snippets by language. There is no way to build different languages in a single Webpack process.
	// Webpack must be called as many times as different languages are being used in snippets.
	for ( const snippetData of snippets ) {
		// Multi-languages editors must be built separately.
		if ( snippetData.snippetConfig.additionalLanguages ) {
			snippetData.snippetConfig.additionalLanguages.push( snippetData.snippetConfig.language );
			snippetData.snippetConfig.language = MULTI_LANGUAGE;
		}

		if ( !groupedSnippetsByLanguage[ snippetData.snippetConfig.language ] ) {
			groupedSnippetsByLanguage[ snippetData.snippetConfig.language ] = new Set();
		}

		groupedSnippetsByLanguage[ snippetData.snippetConfig.language ].add( snippetData );
	}

	// For each language prepare own Webpack configuration. Additionally, split all snippets into smaller sets (chunks), so that the
	// building process will not end unexpectedly due to lack of memory.
	const webpackConfigs = Object.keys( groupedSnippetsByLanguage )
		.flatMap( language => {
			const snippetsChunks = splitSnippetsIntoChunks( groupedSnippetsByLanguage[ language ], SNIPPETS_BUILD_CHUNK_SIZE );

			return snippetsChunks.map( snippetsChunk => {
				return getWebpackConfig( snippetsChunk, {
					language,
					production: options.production,
					definitions: {
						...( options.definitions || {} ),
						...constantDefinitions
					}
				} );
			} );
		} );

	// Nothing to build.
	if ( !webpackConfigs.length ) {
		return;
	}

	for ( const config of webpackConfigs ) {
		const { language, additionalLanguages } = config.plugins.find( plugin => plugin instanceof CKEditorTranslationsPlugin ).options;
		const textLang = additionalLanguages ? additionalLanguages.join( ', ' ) : language;

		const spinner = tools.createSpinner(
			`Building next group of snippets (${ Object.keys( config.entry ).length }) for language "${ textLang }"...`
		);
		spinner.start();

		await runWebpack( config );

		spinner.finish( { emoji: '✔️ ' } );
	}

	const webpackConfig = getWebpackConfigForAssets( {
		production: options.production,
		snippetWebpackConfig: webpackConfigs[ 0 ]
	} );

	const spinnerAssets = tools.createSpinner( 'Building documentation assets...' );
	spinnerAssets.start();

	return runWebpack( webpackConfig )
		.then( () => {
			spinnerAssets.finish( { emoji: '✔️ ' } );

			// Group snippets by destination path in order to attach required HTML code and assets (CSS and JS).
			const groupedSnippetsByDestinationPath = {};

			for ( const snippetData of snippets ) {
				if ( !groupedSnippetsByDestinationPath[ snippetData.destinationPath ] ) {
					groupedSnippetsByDestinationPath[ snippetData.destinationPath ] = new Set();
				}

				groupedSnippetsByDestinationPath[ snippetData.destinationPath ].add( snippetData );
			}

			// For every page that contains at least one snippet, we need to replace Umberto comments with HTML code.
			for ( const destinationPath of Object.keys( groupedSnippetsByDestinationPath ) ) {
				const snippetsOnPage = groupedSnippetsByDestinationPath[ destinationPath ];

				// Assets required for the all snippets.
				const cssFiles = [];
				const jsFiles = [];

				let content = fs.readFileSync( destinationPath ).toString();

				for ( const snippetData of snippetsOnPage ) {
					// CSS may not be generated by Webpack if a snippet's JS file didn't import any CSS files.
					const wasCSSGenerated = fs.existsSync( upath.join( snippetData.outputPath, snippetData.snippetName, 'snippet.css' ) );

					// If the snippet is a dependency, append JS and CSS to HTML, save to disk and continue.
					if ( snippetData.requiredFor ) {
						let htmlFile = fs.readFileSync( snippetData.snippetSources.html ).toString();

						if ( wasCSSGenerated ) {
							htmlFile += '<link rel="stylesheet" href="snippet.css" type="text/css">';
						}

						htmlFile += '<script src="snippet.js"></script>';

						fs.writeFileSync( upath.join( snippetData.outputPath, snippetData.snippetName, 'snippet.html' ), htmlFile );

						continue;
					}

					let snippetHTML = fs.readFileSync( snippetData.snippetSources.html ).toString();

					if ( snippetHTML.trim() ) {
						snippetHTML = snippetHTML.replace( /%BASE_PATH%/g, snippetData.basePath );
						snippetHTML = `<div class="live-snippet">${ snippetHTML }</div>`;
					}

					content = content.replace( getSnippetPlaceholder( snippetData.snippetName ), snippetHTML );

					// This file is copied by Umberto itself.
					jsFiles.push( upath.join( snippetData.basePath, 'assets', 'snippet.js' ) );

					// This file is produced by the snippet adapter.
					jsFiles.push( upath.join( snippetData.relativeOutputPath, 'assets.js' ) );

					// The snippet source.
					jsFiles.push( upath.join( snippetData.relativeOutputPath, snippetData.snippetName, 'snippet.js' ) );

					if ( wasCSSGenerated ) {
						cssFiles.unshift( upath.join( snippetData.relativeOutputPath, snippetData.snippetName, 'snippet.css' ) );
					}

					cssFiles.push( upath.join( snippetData.basePath, 'assets', 'snippet-styles.css' ) );

					// This file is produced by the snippet adapter.
					cssFiles.push( upath.join( snippetData.relativeOutputPath, 'assets.css' ) );

					// Additional languages must be imported by the HTML code.
					if ( snippetData.snippetConfig.additionalLanguages ) {
						snippetData.snippetConfig.additionalLanguages.forEach( language => {
							jsFiles.push( upath.join( snippetData.relativeOutputPath, 'translations', `${ language }.js` ) );
						} );
					}
				}

				const cssImportsHTML = getHTMLImports( cssFiles, importPath => {
					return `    <link rel="stylesheet" href="${ importPath }" type="text/css" data-cke="true">`;
				} );

				const jsImportsHTML = getHTMLImports( jsFiles, importPath => {
					return `    <script src="${ importPath }"></script>`;
				} );

				content = content.replace( '<!--UMBERTO: SNIPPET: CSS-->', cssImportsHTML );
				content = content.replace( '<!--UMBERTO: SNIPPET: JS-->', jsImportsHTML );

				fs.writeFileSync( destinationPath, content );
			}
		} )
		.then( () => {
			console.log( 'Finished building snippets.' );
		} );
}

/**
 * Removes snippets that names do not match to patterns specified in `allowedSnippets` array.
 *
 * @param {Set.<Snippet>} snippets Snippet collection extracted from documentation files.
 * @param {Array.<String>} allowedSnippets Snippet patterns that should be built.
 */
function filterAllowedSnippets( snippets, allowedSnippets ) {
	const snippetsToBuild = new Set();

	// Find all snippets that matched to specified criteria.
	for ( const snippetData of snippets ) {
		const shouldBeBuilt = allowedSnippets.some( pattern => {
			return minimatch( snippetData.snippetName, pattern ) || snippetData.snippetName.includes( pattern );
		} );

		if ( shouldBeBuilt ) {
			snippetsToBuild.add( snippetData );
		}
	}

	// Find all dependencies that are required for whitelisted snippets.
	for ( const snippetData of snippets ) {
		if ( snippetsToBuild.has( snippetData ) ) {
			continue;
		}

		if ( snippetData.requiredFor && snippetsToBuild.has( snippetData.requiredFor ) ) {
			snippetsToBuild.add( snippetData );
		}
	}

	// Remove snippets that won't be built and aren't dependencies of other snippets.
	for ( const snippetData of snippets ) {
		if ( !snippetsToBuild.has( snippetData ) ) {
			snippets.delete( snippetData );
		}
	}
}

/**
 * Adds constants to the webpack process from external repositories containing `docs/constants.js` files.
 *
 * @param {Array.<Object>} snippets
 * @returns {Object}
 */
async function getConstantDefinitions( snippets ) {
	const knownPaths = new Set();
	const constantDefinitions = {};
	const constantOrigins = new Map();

	for ( const snippet of snippets ) {
		if ( !snippet.pageSourcePath ) {
			continue;
		}

		let directory = upath.dirname( snippet.pageSourcePath );

		while ( !knownPaths.has( directory ) ) {
			knownPaths.add( directory );

			const constantsFiles = globSync( 'constants.*js', {
				absolute: true,
				cwd: upath.join( directory, 'docs' )
			} );

			for ( const item of constantsFiles ) {
				const importPathToConstants = upath.relative( __dirname, item );

				const { default: packageConstantDefinitions } = await import( './' + importPathToConstants );

				for ( const constantName in packageConstantDefinitions ) {
					const constantValue = packageConstantDefinitions[ constantName ];

					if ( constantDefinitions[ constantName ] && constantDefinitions[ constantName ] !== constantValue ) {
						throw new Error(
							`Definition for the '${ constantName }' constant is duplicated` +
							` (${ importPathToConstants }, ${ constantOrigins.get( constantName ) }).`
						);
					}

					constantDefinitions[ constantName ] = constantValue;
					constantOrigins.set( constantName, importPathToConstants );
				}

				Object.assign( constantDefinitions, packageConstantDefinitions );
			}

			directory = upath.dirname( directory );
		}
	}

	return constantDefinitions;
}

/**
 * Prepares configuration for Webpack.
 *
 * @param {Set.<Snippet>} snippets Snippet collection extracted from documentation files.
 * @param {Object} config
 * @param {String} config.language Language for the build.
 * @param {Boolean} config.production Whether to build for production.
 * @param {Object} config.definitions
 * @returns {Object}
 */
function getWebpackConfig( snippets, config ) {
	// Stringify all definitions values. The `DefinePlugin` injects definition values as they are so we need to stringify them,
	// so they will become real strings in the generated code. See https://webpack.js.org/plugins/define-plugin/ for more information.
	const definitions = {};

	for ( const definitionKey in config.definitions ) {
		definitions[ definitionKey ] = JSON.stringify( config.definitions[ definitionKey ] );
	}

	const ckeditorTranslationsPluginOptions = {
		// All translation files are added to HTML files directly later.
		buildAllTranslationsToSeparateFiles: true
	};

	if ( config.language === MULTI_LANGUAGE ) {
		const additionalLanguages = new Set();

		// Find all additional languages that must be built.
		for ( const snippetData of snippets ) {
			for ( const language of snippetData.snippetConfig.additionalLanguages ) {
				additionalLanguages.add( language );
			}
		}

		// Pass unique values of `additionalLanguages` to `CKEditorTranslationsPlugin`.
		ckeditorTranslationsPluginOptions.additionalLanguages = [ ...additionalLanguages ];

		// Also, set the default language because of the warning that comes from the plugin.
		ckeditorTranslationsPluginOptions.language = DEFAULT_LANGUAGE;
	} else {
		ckeditorTranslationsPluginOptions.language = config.language;
	}

	const webpackConfig = {
		mode: config.production ? 'production' : 'development',

		entry: {},

		output: {
			filename: '[name]/snippet.js'
		},

		devtool: 'source-map',

		optimization: {
			minimizer: [
				new TerserPlugin( {
					terserOptions: {
						output: {
							// Preserve CKEditor 5 license comments.
							comments: /^!/
						}
					},
					extractComments: false
				} )
			]
		},

		plugins: [
			new MiniCssExtractPlugin( { filename: '[name]/snippet.css' } ),
			new CKEditorTranslationsPlugin( ckeditorTranslationsPluginOptions ),
			new webpack.BannerPlugin( {
				banner: bundler.getLicenseBanner(),
				raw: true
			} ),
			new webpack.DefinePlugin( definitions )
		],

		// Configure the paths so building CKEditor 5 snippets work even if the script
		// is triggered from a directory outside ckeditor5 (e.g. multi-project case).
		resolve: {
			modules: [
				...getPackageDependenciesPaths(),
				...getModuleResolvePaths()
			],
			alias: RESOLVE_ALIAS_MAP,
			extensions: [ '.ts', '.js', '.json' ],
			extensionAlias: {
				'.js': [ '.js', '.ts' ]
			},
			fallback: {
				crypto: false
			}
		},

		resolveLoader: {
			modules: getModuleResolvePaths()
		},

		module: {
			rules: [
				loaders.getIconsLoader( { matchExtensionOnly: true } ),
				loaders.getStylesLoader( {
					themePath: require.resolve( '@ckeditor/ckeditor5-theme-lark' ),
					minify: config.production,
					extractToSeparateFile: true
				} )
			]
		}
	};

	addTypeScriptLoader( webpackConfig, 'tsconfig.docs.json' );

	for ( const snippetData of snippets ) {
		if ( !webpackConfig.output.path ) {
			webpackConfig.output.path = upath.normalize( snippetData.outputPath );
		}

		if ( webpackConfig.entry[ snippetData.snippetName ] ) {
			continue;
		}

		webpackConfig.entry[ snippetData.snippetName ] = snippetData.snippetSources.js;
	}

	return webpackConfig;
}

/**
 * Builds snippets.
 *
 * @param {Object} webpackConfig
 * @returns {Promise}
 */
function runWebpack( webpackConfig ) {
	return new Promise( ( resolve, reject ) => {
		webpack( webpackConfig, ( err, stats ) => {
			if ( err ) {
				reject( err );
			} else if ( stats.hasErrors() ) {
				reject( new Error( stats.toString() ) );
			} else {
				resolve();
			}
		} );
	} );
}

/**
 * @returns {Array.<String>}
 */
function getModuleResolvePaths() {
	return [
		upath.resolve( __dirname, '..', '..', 'node_modules' ),
		'node_modules'
	];
}

/**
 * Returns an array that contains paths to packages' dependencies.
 * The snippet adapter should use packages' dependencies instead of the documentation builder dependencies.
 *
 * See #7916.
 *
 * @returns {Array.<String>}
 */
function getPackageDependenciesPaths() {
	const globOptions = {
		cwd: upath.resolve( __dirname, '..', '..' ),
		absolute: true
	};

	return globSync( [ 'packages/*/node_modules', 'external/ckeditor5-commercial/packages/*/node_modules' ], globOptions )
		.map( p => upath.normalize( p ) );
}

/**
 * Reads the snippet's configuration.
 *
 * @param {String} snippetSourcePath An absolute path to the file.
 * @returns {Object}
 */
function readSnippetConfig( snippetSourcePath ) {
	const snippetSource = fs.readFileSync( snippetSourcePath ).toString();

	const configSourceMatch = snippetSource.match( /\n\/\* config ([\s\S]+?)\*\// );

	if ( !configSourceMatch ) {
		return {};
	}

	return JSON.parse( configSourceMatch[ 1 ] );
}

/**
 * Removes duplicated entries specified in `files` array, unifies path separators to always be `/`
 * and then maps those entries using `mapFunction`.
 *
 * @param {Array.<String>} files Paths collection.
 * @param {Function} mapFunction Function that should return a string.
 * @returns {String}
 */
function getHTMLImports( files, mapFunction ) {
	return [ ...new Set( files ) ]
		.map( value => upath.normalize( value ) )
		.map( mapFunction )
		.join( '\n' )
		.replace( /^\s+/, '' );
}

/**
 * Splits all snippets into smaller sets (chunks).
 *
 * Snippets belonging to the same page will not be separated from others on that page to make sure they all are built correctly. Such
 * snippets cannot be divided. For this reason, the size of each created chunk may not be exactly equal to the requested chunk size
 * and the final size depends on whether a page contained many indivisible snippets to build.
 *
 * @param {Set.<Snippet>} snippets Snippet collection extracted from documentation files.
 * @param {Number} chunkSize The size of the group of snippets to be built simultaneously by one webpack process.
 * @returns {Array.<Set.<Snippet>>}
 */
function splitSnippetsIntoChunks( snippets, chunkSize ) {
	const groupedSnippetsByPage = [ ...snippets ].reduce( ( result, snippet ) => {
		if ( !result[ snippet.pageSourcePath ] ) {
			result[ snippet.pageSourcePath ] = [];
		}

		result[ snippet.pageSourcePath ].push( snippet );

		return result;
	}, {} );

	const chunks = [ {} ];

	for ( const snippets of Object.values( groupedSnippetsByPage ) ) {
		const lastChunk = chunks.pop();
		const numberOfSnippetsInLastChunk = Object.keys( lastChunk ).length;
		const snippetsEntries = Object.fromEntries( snippets.map( snippet => [ snippet.snippetName, snippet ] ) );

		if ( numberOfSnippetsInLastChunk < chunkSize ) {
			chunks.push( { ...lastChunk, ...snippetsEntries } );
		} else {
			chunks.push( lastChunk, snippetsEntries );
		}
	}

	return chunks.map( chunk => new Set( Object.values( chunk ) ) );
}

/**
 * Returns a configuration for webpack that parses the `/docs/_snippets/assets.js` file.
 * Thanks to that, we're able to load libraries from the `node_modules` directory in our snippets.
 *
 * @param {Object} config
 * @param {Boolean} config.production Whether to build for production.
 * @param {Object} config.snippetWebpackConfig The configuration returned by the `getWebpackConfig()` function.
 * It is used to configure the output path for the asset file.
 * @returns {Object}
 */
function getWebpackConfigForAssets( config ) {
	const webpackConfig = {
		mode: config.production ? 'production' : 'development',

		entry: {
			assets: upath.join( __dirname, '..', '..', 'docs', '_snippets', 'assets.js' )
		},

		output: {
			filename: '[name].js',
			path: config.snippetWebpackConfig.output.path
		},

		optimization: {
			minimizer: [
				new TerserPlugin( {
					terserOptions: {
						output: {
							// Preserve CKEditor 5 license comments.
							comments: /^!/
						}
					},
					extractComments: false
				} )
			]
		},

		plugins: [
			new MiniCssExtractPlugin( { filename: '[name].css' } ),
			new webpack.BannerPlugin( {
				banner: bundler.getLicenseBanner(),
				raw: true
			} )
		],

		// Configure the paths so building CKEditor 5 snippets work even if the script
		// is triggered from a directory outside ckeditor5 (e.g. multi-project case).
		resolve: {
			modules: [
				...getPackageDependenciesPaths(),
				...getModuleResolvePaths()
			],
			extensions: [ '.ts', '.js', '.json' ],
			extensionAlias: {
				'.js': [ '.js', '.ts' ]
			}
		},

		resolveLoader: {
			modules: getModuleResolvePaths()
		},

		module: {
			rules: [
				loaders.getStylesLoader( {
					skipPostCssLoader: true,
					extractToSeparateFile: true
				} )
			]
		}
	};

	addTypeScriptLoader( webpackConfig, 'tsconfig.docs.json' );

	return webpackConfig;
}

/**
 * @typedef {Object} Snippet
 *
 * @property {SnippetSource} snippetSources Sources of the snippet.
 *
 * @property {String} snippetName Name of the snippet. Defined directly after `@snippet` tag.
 *
 * @property {String} outputPath An absolute path where to write file produced by the `snippetAdapter`.
 *
 * @property {String} destinationPath An absolute path to the file where the snippet is being used.
 *
 * @property {SnippetConfiguration} snippetConfig={} Additional configuration of the snippet. It's being read from the snippet's source.
 *
 * @property {String} [basePath] Relative path from the processed file to the root of the documentation.
 *
 * @property {String} [relativeOutputPath] The same like `basePath` but for the output path (where processed file will be saved).
 *
 * @property {Snippet|undefined} [requiredFor] If the value is instance of `Snippet`, current snippet requires
 * the snippet defined as `requiredFor` to work.
 */

/**
 * @typedef {Object} SnippetSource
 *
 * @property {String} html An absolute path to the HTML sample.
 *
 * @property {String} css An absolute path to the CSS sample.
 *
 * @property {String} js An absolute path to the JS sample.
 */

/**
 * @typedef {Object} SnippetConfiguration
 *
 * @property {String} [language] A language that will be used for building the editor.
 *
 * @property {Array.<String>} [dependencies] Names of samples that are required to working.
 *
 * @property {Array.<String>} [additionalLanguages] Additional languages that are required by the snippet.
 */
