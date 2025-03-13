/**
 * @license Copyright (c) 2003-2025, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-licensing-options
 */

/**
 * @module table/tableproperties/tablepropertiesediting
 */

import { Plugin } from 'ckeditor5/src/core.js';
import { addBackgroundRules, addBorderRules, type ViewElement, type Conversion, type Schema } from 'ckeditor5/src/engine.js';

import TableEditing from '../tableediting.js';
import {
	downcastTableAttribute,
	upcastBorderStyles,
	upcastStyleToAttribute
} from '../converters/tableproperties.js';
import TableBackgroundColorCommand from './commands/tablebackgroundcolorcommand.js';
import TableBorderColorCommand from './commands/tablebordercolorcommand.js';
import TableBorderStyleCommand from './commands/tableborderstylecommand.js';
import TableBorderWidthCommand from './commands/tableborderwidthcommand.js';
import TableWidthCommand from './commands/tablewidthcommand.js';
import TableHeightCommand from './commands/tableheightcommand.js';
import TableAlignmentCommand from './commands/tablealignmentcommand.js';
import { getNormalizedDefaultTableProperties } from '../utils/table-properties.js';

const ALIGN_VALUES_REG_EXP = /^(left|center|right)$/;
const FLOAT_VALUES_REG_EXP = /^(left|none|right)$/;

/**
 * The table properties editing feature.
 *
 * Introduces table's model attributes and their conversion:
 *
 * - border: `tableBorderStyle`, `tableBorderColor` and `tableBorderWidth`
 * - background color: `tableBackgroundColor`
 * - horizontal alignment: `tableAlignment`
 * - width & height: `tableWidth` & `tableHeight`
 *
 * It also registers commands used to manipulate the above attributes:
 *
 * - border: `'tableBorderStyle'`, `'tableBorderColor'` and `'tableBorderWidth'` commands
 * - background color: `'tableBackgroundColor'`
 * - horizontal alignment: `'tableAlignment'`
 * - width & height: `'tableWidth'` & `'tableHeight'`
 */
export default class TablePropertiesEditing extends Plugin {
	/**
	 * @inheritDoc
	 */
	public static get pluginName() {
		return 'TablePropertiesEditing' as const;
	}

	/**
	 * @inheritDoc
	 */
	public static override get isOfficialPlugin(): true {
		return true;
	}

	/**
	 * @inheritDoc
	 */
	public static get requires() {
		return [ TableEditing ] as const;
	}

	/**
	 * @inheritDoc
	 */
	public init(): void {
		const editor = this.editor;
		const schema = editor.model.schema;
		const conversion = editor.conversion;

		editor.config.define( 'table.tableProperties.defaultProperties', {} );

		const defaultTableProperties = getNormalizedDefaultTableProperties(
			editor.config.get( 'table.tableProperties.defaultProperties' )!,
			{
				includeAlignmentProperty: true
			}
		);

		editor.data.addStyleProcessorRules( addBorderRules );
		enableBorderProperties( schema, conversion, {
			color: defaultTableProperties.borderColor,
			style: defaultTableProperties.borderStyle,
			width: defaultTableProperties.borderWidth
		} );

		editor.commands.add( 'tableBorderColor', new TableBorderColorCommand( editor, defaultTableProperties.borderColor ) );
		editor.commands.add( 'tableBorderStyle', new TableBorderStyleCommand( editor, defaultTableProperties.borderStyle ) );
		editor.commands.add( 'tableBorderWidth', new TableBorderWidthCommand( editor, defaultTableProperties.borderWidth ) );

		enableAlignmentProperty( schema, conversion, defaultTableProperties.alignment! );
		editor.commands.add( 'tableAlignment', new TableAlignmentCommand( editor, defaultTableProperties.alignment! ) );

		enableTableToFigureProperty( schema, conversion, {
			modelAttribute: 'tableWidth',
			styleName: 'width',
			defaultValue: defaultTableProperties.width
		} );
		editor.commands.add( 'tableWidth', new TableWidthCommand( editor, defaultTableProperties.width ) );

		enableTableToFigureProperty( schema, conversion, {
			modelAttribute: 'tableHeight',
			styleName: 'height',
			defaultValue: defaultTableProperties.height
		} );
		editor.commands.add( 'tableHeight', new TableHeightCommand( editor, defaultTableProperties.height ) );

		editor.data.addStyleProcessorRules( addBackgroundRules );
		enableProperty( schema, conversion, {
			modelAttribute: 'tableBackgroundColor',
			styleName: 'background-color',
			defaultValue: defaultTableProperties.backgroundColor
		} );
		conversion.for( 'upcast' ).attributeToAttribute( {
			view: {
				name: 'table',
				attributes: {
					class: /ck-custom-background-color/,
					'background-color': /[\s\S]+/
				}
			},
			model: {
				key: 'tableBackgroundColor',
				value: ( viewElement: ViewElement ) => {
					const value = viewElement.getAttribute( 'background-color' );
					if ( value && defaultTableProperties.backgroundColor !== value ) {
						return value;
					}
				}
			}
		} );
		editor.commands.add(
			'tableBackgroundColor',
			new TableBackgroundColorCommand( editor, defaultTableProperties.backgroundColor )
		);
	}
}

/**
 * Enables `tableBorderStyle'`, `tableBorderColor'` and `tableBorderWidth'` attributes for table.
 *
 * @param defaultBorder The default border values.
 * @param defaultBorder.color The default `tableBorderColor` value.
 * @param defaultBorder.style The default `tableBorderStyle` value.
 * @param defaultBorder.width The default `tableBorderWidth` value.
 */
function enableBorderProperties( schema: Schema, conversion: Conversion, defaultBorder: { color: string; style: string; width: string } ) {
	const modelAttributes = {
		width: 'tableBorderWidth',
		color: 'tableBorderColor',
		style: 'tableBorderStyle'
	};

	schema.extend( 'table', {
		allowAttributes: Object.values( modelAttributes )
	} );

	upcastBorderStyles( conversion, 'table', modelAttributes, defaultBorder );

	downcastTableAttribute( conversion, { modelAttribute: modelAttributes.color, styleName: 'border-color' } );
	downcastTableAttribute( conversion, { modelAttribute: modelAttributes.style, styleName: 'border-style' } );
	downcastTableAttribute( conversion, { modelAttribute: modelAttributes.width, styleName: 'border-width' } );
}

/**
 * Enables the `'alignment'` attribute for table.
 *
 * @param defaultValue The default alignment value.
 */
function enableAlignmentProperty( schema: Schema, conversion: Conversion, defaultValue: string ) {
	schema.extend( 'table', {
		allowAttributes: [ 'tableAlignment' ]
	} );

	conversion.for( 'downcast' ).add( dispatcher => {
		return dispatcher.on( `attribute:${ 'tableAlignment' }:table`, ( evt, data, conversionApi ) => {
			const { item, attributeNewValue } = data;
			const { mapper, writer } = conversionApi;
			if ( !conversionApi.consumable.consume( data.item, evt.name ) ) {
				return;
			}
			const parentChildren = mapper.toViewElement( item )?.parent?.getChildren?.();
			if ( parentChildren ) {
				const figureEl = [ ...parentChildren ].find( c => c?.is?.( 'element', 'figure' ) );
				const className = 'ck-custom-alignment';
				if ( figureEl && attributeNewValue ) {
					writer.addClass( className, figureEl );
					const alignment = attributeNewValue === 'center' ? 'none' : attributeNewValue;
					writer.setAttribute( 'alignment', alignment, null, figureEl );
				} else {
					writer.removeClass( className, figureEl );
					writer.removeAttribute( 'alignment', null, figureEl );
				}
			}
		} );
	} );

	conversion.for( 'upcast' )
		.attributeToAttribute( {
			view: {
				name: /^(table|figure)$/,
				attributes: {
					class: /ck-custom-alignment/,
					alignment: FLOAT_VALUES_REG_EXP
				}
			},
			model: {
				key: 'tableAlignment',
				value: ( viewElement: ViewElement ) => {
					let align = viewElement.getAttribute( 'alignment' );
					// CSS: `float:none` => Model: `alignment:center`.
					if ( align === 'none' ) {
						align = 'center';
					}

					return align === defaultValue ? null : align;
				}
			}
		} );

	conversion.for( 'upcast' )
		// Support for the `float:*;` CSS definition for the table alignment.
		.attributeToAttribute( {
			view: {
				name: /^(table|figure)$/,
				styles: {
					float: FLOAT_VALUES_REG_EXP
				}
			},
			model: {
				key: 'tableAlignment',
				value: ( viewElement: ViewElement ) => {
					let align = viewElement.getStyle( 'float' );

					// CSS: `float:none` => Model: `alignment:center`.
					if ( align === 'none' ) {
						align = 'center';
					}

					return align === defaultValue ? null : align;
				}
			}
		} )
		// Support for the `align` attribute as the backward compatibility while pasting from other sources.
		.attributeToAttribute( {
			view: {
				attributes: {
					align: ALIGN_VALUES_REG_EXP
				}
			},
			model: {
				name: 'table',
				key: 'tableAlignment',
				value: ( viewElement: ViewElement ) => {
					const align = viewElement.getAttribute( 'align' );

					return align === defaultValue ? null : align;
				}
			}
		} );
}

/**
 * Enables conversion for an attribute for simple view-model mappings.
 *
 * @param options.defaultValue The default value for the specified `modelAttribute`.
 */
function enableProperty(
	schema: Schema,
	conversion: Conversion,
	options: {
		modelAttribute: string;
		styleName: string;
		defaultValue: string;
	}
) {
	const { modelAttribute } = options;

	schema.extend( 'table', {
		allowAttributes: [ modelAttribute ]
	} );
	upcastStyleToAttribute( conversion, { viewElement: 'table', ...options } );
	downcastTableAttribute( conversion, options );
}

/**
 * Enables conversion for an attribute for simple view (figure) to model (table) mappings.
 */
function enableTableToFigureProperty(
	schema: Schema,
	conversion: Conversion,
	options: {
		modelAttribute: string;
		styleName: string;
		defaultValue: string;
	}
) {
	const { modelAttribute, styleName, defaultValue } = options;

	schema.extend( 'table', {
		allowAttributes: [ modelAttribute ]
	} );

	upcastStyleToAttribute( conversion, {
		viewElement: /^(table|figure)$/,
		shouldUpcast: ( element: ViewElement ) => !( element.name == 'table' && element.parent!.name == 'figure' ),
		...options
	} );

	conversion.for( 'upcast' ).attributeToAttribute( {
		view: {
			name: /^(table|figure)$/,
			attributes: {
				class: `ck-custom-${ styleName }`,
				[ styleName ]: /[\s\S]+/
			}
		},
		model: {
			key: modelAttribute,
			value: ( viewElement: ViewElement ) => {
				const value = viewElement.getAttribute( styleName );
				if ( defaultValue !== value ) {
					// return `${ value }px`;
					return value;
				}
			}
		}
	} );

	conversion.for( 'downcast' ).add( dispatcher => {
		return dispatcher.on( `attribute:${ modelAttribute }:table`, ( evt, data, conversionApi ) => {
			const { item, attributeNewValue } = data;
			const { mapper, writer } = conversionApi;
			if ( !conversionApi.consumable.consume( data.item, evt.name ) ) {
				return;
			}
			const parentChildren = mapper.toViewElement( item )?.parent?.getChildren?.();
			if ( parentChildren ) {
				const figureEl = [ ...parentChildren ].find( c => c?.is?.( 'element', 'figure' ) );
				const className = `ck-custom-${ styleName }`;
				if ( figureEl && attributeNewValue ) {
					writer.addClass( className, figureEl );
					// const value = attributeNewValue?.replace?.( /px/g, '' ) ?? attributeNewValue;
					writer.setAttribute( styleName, attributeNewValue, null, figureEl );
				} else {
					writer.removeClass( className, figureEl );
					writer.removeAttribute( styleName, null, figureEl );
				}
			}
		} );
	} );
}
