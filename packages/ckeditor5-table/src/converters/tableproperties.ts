/**
 * @license Copyright (c) 2003-2025, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-licensing-options
 */

/**
 * @module table/converters/tableproperties
 */

import type { Conversion, ViewElement } from 'ckeditor5/src/engine.js';

/**
 * Conversion helper for upcasting attributes using normalized styles.
 *
 * @param options.modelAttribute The attribute to set.
 * @param options.styleName The style name to convert.
 * @param options.viewElement The view element name that should be converted.
 * @param options.defaultValue The default value for the specified `modelAttribute`.
 * @param options.shouldUpcast The function which returns `true` if style should be upcasted from this element.
 */
export function upcastStyleToAttribute(
	conversion: Conversion,
	options: {
		modelAttribute: string;
		styleName: string;
		viewElement: string | RegExp;
		defaultValue: string;
		reduceBoxSides?: boolean;
		shouldUpcast?: ( viewElement: ViewElement ) => boolean;
	}
): void {
	const {
		modelAttribute,
		styleName,
		viewElement,
		defaultValue,
		reduceBoxSides = false,
		shouldUpcast = () => true
	} = options;

	conversion.for( 'upcast' ).attributeToAttribute( {
		view: {
			name: viewElement,
			styles: {
				[ styleName ]: /[\s\S]+/
			}
		},
		model: {
			key: modelAttribute,
			value: ( viewElement: ViewElement ) => {
				if ( !shouldUpcast( viewElement ) ) {
					return;
				}

				const normalized = viewElement.getNormalizedStyle( styleName ) as Record<Side, string>;
				const value = reduceBoxSides ? reduceBoxSidesValue( normalized ) : normalized;

				if ( defaultValue !== value ) {
					return value;
				}
			}
		}
	} );
}

export interface StyleValues {
	color: string;
	style: string;
	width: string;
}

/**
 * Conversion helper for upcasting border styles for view elements.
 *
 * @param defaultBorder The default border values.
 * @param defaultBorder.color The default `borderColor` value.
 * @param defaultBorder.style The default `borderStyle` value.
 * @param defaultBorder.width The default `borderWidth` value.
 */
export function upcastBorderStyles(
	conversion: Conversion,
	viewElementName: string,
	modelAttributes: StyleValues,
	defaultBorder: StyleValues
): void {
	conversion.for( 'upcast' ).add( dispatcher => dispatcher.on( 'element:' + viewElementName, ( evt, data, conversionApi ) => {
		// If the element was not converted by element-to-element converter,
		// we should not try to convert the style. See #8393.
		if ( !data.modelRange ) {
			return;
		}

		// Check the most detailed properties. These will be always set directly or
		// when using the "group" properties like: `border-(top|right|bottom|left)` or `border`.
		const stylesToConsume = [
			'border-top-width',
			'border-top-color',
			'border-top-style',
			'border-bottom-width',
			'border-bottom-color',
			'border-bottom-style',
			'border-right-width',
			'border-right-color',
			'border-right-style',
			'border-left-width',
			'border-left-color',
			'border-left-style'
		].filter( styleName => data.viewItem.hasStyle( styleName ) );

		const modelElement = [ ...data.modelRange.getItems( { shallow: true } ) ].pop();

		// custom class and attribute upcast formatting
		if ( data.viewItem.hasClass( 'ck-custom-border-color' ) ) {
			const borderColor = data.viewItem.getAttribute( 'border-color' );
			if ( borderColor ) {
				conversionApi.writer.setAttribute( 'tableBorderColor', borderColor, modelElement );
			}
		}
		if ( data.viewItem.hasClass( 'ck-custom-border-width' ) ) {
			const borderWidth = data.viewItem.getAttribute( 'border-width' );
			if ( borderWidth ) {
				conversionApi.writer.setAttribute( 'tableBorderWidth', borderWidth, modelElement );
				// conversionApi.writer.setAttribute( 'tableBorderWidth', `${ borderWidth }px`, modelElement );
			}
		}
		if ( data.viewItem.hasClass( 'ck-custom-border-style' ) ) {
			const borderStyle = data.viewItem.getAttribute( 'border-style' );
			if ( borderStyle ) {
				conversionApi.writer.setAttribute( 'tableBorderStyle', borderStyle, modelElement );
			}
		}

		if ( !stylesToConsume.length ) {
			return;
		}

		const matcherPattern = {
			styles: stylesToConsume
		};

		// Try to consume appropriate values from consumable values list.
		if ( !conversionApi.consumable.test( data.viewItem, matcherPattern ) ) {
			return;
		}

		conversionApi.consumable.consume( data.viewItem, matcherPattern );

		const normalizedBorder = {
			style: data.viewItem.getNormalizedStyle( 'border-style' ),
			color: data.viewItem.getNormalizedStyle( 'border-color' ),
			width: data.viewItem.getNormalizedStyle( 'border-width' )
		};

		const reducedBorder = {
			style: reduceBoxSidesValue( normalizedBorder.style ),
			color: reduceBoxSidesValue( normalizedBorder.color ),
			width: reduceBoxSidesValue( normalizedBorder.width )
		};

		if ( reducedBorder.style !== defaultBorder.style ) {
			conversionApi.writer.setAttribute( modelAttributes.style, reducedBorder.style, modelElement );
		}

		if ( reducedBorder.color !== defaultBorder.color ) {
			conversionApi.writer.setAttribute( modelAttributes.color, reducedBorder.color, modelElement );
		}

		if ( reducedBorder.width !== defaultBorder.width ) {
			conversionApi.writer.setAttribute( modelAttributes.width, reducedBorder.width, modelElement );
		}
	} ) );
	if ( viewElementName === 'td' || viewElementName === 'th' ) {
		conversion.for( 'upcast' ).add( dispatcher => dispatcher.on( 'element:' + viewElementName, ( evt, data, conversionApi ) => {
			// If the element was not converted by element-to-element converter,
			// we should not try to convert the style. See #8393.
			if ( !data.modelRange ) {
				return;
			}

			const classesToConsume = [
				'ck-custom-border-style',
				'ck-custom-border-color',
				'ck-custom-border-width',
				'ck-custom-background-color',
				'ck-custom-height',
				'ck-custom-width',
				'ck-custom-vertical-align',
				'ck-custom-padding'
			].filter( styleName => data.viewItem.hasClass( styleName ) );

			if ( !classesToConsume.length ) {
				return;
			}

			const matcherPattern = {
				class: classesToConsume
			};

			// Try to consume appropriate values from consumable values list.
			if ( !conversionApi.consumable.test( data.viewItem, matcherPattern ) ) {
				return;
			}

			const classMapping: any = {
				'border-style': 'tableCellBorderStyle',
				'border-color': 'tableCellBorderColor',
				'border-width': 'tableCellBorderWidth',
				'background-color': 'tableCellBackgroundColor',
				'width': 'tableCellWidth',
				'height': 'tableCellHeight',
				'padding': 'tableCellPadding'
			};

			const modelElement = [ ...data.modelRange.getItems( { shallow: true } ) ].pop();

			conversionApi.consumable.consume( data.viewItem, matcherPattern );
			const attrsValue = data.viewItem?._attrs ?? {};
			for ( const [ key, value ] of attrsValue ) {
				if ( classMapping && classMapping[ key ] ) {
					conversionApi.writer.setAttribute( classMapping[ key ], value, modelElement );
				}
			}
		} ) );
	}
}

/**
 * Conversion helper for downcasting an attribute to a style.
 */
export function downcastAttributeToStyle(
	conversion: Conversion,
	options: {
		modelElement: string;
		modelAttribute: string;
		styleName: string;
	}
): void {
	const { modelAttribute, styleName } = options;

	conversion.for( 'downcast' )
		.add( dispatcher => dispatcher.on( `attribute:${ modelAttribute }:tableCell`, ( evt, data, conversionApi ) => {
			const { item, attributeNewValue } = data;
			const { mapper, writer } = conversionApi;

			if ( !conversionApi.consumable.consume( data.item, evt.name ) ) {
				return;
			}

			const mapViewElement = mapper.toViewElement( item );

			if ( attributeNewValue ) {
				writer.addClass( `ck-custom-${ styleName }`, mapViewElement );
				writer.setAttribute( styleName, attributeNewValue, null, mapViewElement );
			} else {
				writer.removeClass( `ck-custom-${ styleName }`, mapViewElement );
				writer.removeAttribute( styleName, null, mapViewElement );
			}
		} ) );
}

/**
 * Conversion helper for downcasting attributes from the model table to a view table (not to `<figure>`).
 */
export function downcastTableAttribute(
	conversion: Conversion,
	options: {
		modelAttribute: string;
		styleName: string;
	}
): void {
	const { modelAttribute, styleName } = options;

	conversion.for( 'downcast' ).add( dispatcher => dispatcher.on( `attribute:${ modelAttribute }:table`, ( evt, data, conversionApi ) => {
		const { item, attributeNewValue } = data;
		const { mapper, writer } = conversionApi;

		if ( !conversionApi.consumable.consume( data.item, evt.name ) ) {
			return;
		}

		const table = [ ...mapper.toViewElement( item ).getChildren() ].find( child => child.is( 'element', 'table' ) );
		const className = `ck-custom-${ styleName }`;
		if ( attributeNewValue ) {
			writer.addClass( className, table );
			// const formattedValue = styleName === 'border-width' ? attributeNewValue?.replace?.( /px/g, '' ) : attributeNewValue;
			writer.setAttribute( styleName, attributeNewValue, null, table );
		} else {
			writer.removeClass( className, table );
			writer.removeAttribute( styleName, null, table );
		}
	} ) );
}

type Side = 'top' | 'right' | 'bottom' | 'left';
type Style = Record<Side, string>;

/**
 * Reduces the full top, right, bottom, left object to a single string if all sides are equal.
 * Returns original style otherwise.
 */
function reduceBoxSidesValue( style?: Style ): undefined | string | Style {
	if ( !style ) {
		return;
	}
	const sides: Array<Side> = [ 'top', 'right', 'bottom', 'left' ];
	const allSidesDefined = sides.every( side => style[ side ] );

	if ( !allSidesDefined ) {
		return style;
	}

	const topSideStyle = style.top;
	const allSidesEqual = sides.every( side => style[ side ] === topSideStyle );

	if ( !allSidesEqual ) {
		return style;
	}

	return topSideStyle;
}
