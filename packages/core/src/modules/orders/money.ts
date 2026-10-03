import { fromMinor } from "@scalius/shared/money";

export interface OrderMoneyColumns {
    currencyDecimalPlaces: number;
    totalAmountMinor: number;
    shippingAmountMinor: number;
    discountAmountMinor: number;
    paidAmountMinor: number;
    balanceDueMinor: number;
}

/** The decimal major-unit fields the HTTP contract carries for an order's integer money columns. */
export function orderMoneyAmounts(order: OrderMoneyColumns) {
    const amount = (minor: number) => fromMinor(minor, order.currencyDecimalPlaces);
    return {
        totalAmount: amount(order.totalAmountMinor),
        shippingCharge: amount(order.shippingAmountMinor),
        discountAmount: amount(order.discountAmountMinor),
        paidAmount: amount(order.paidAmountMinor),
        balanceDue: amount(order.balanceDueMinor),
    };
}

/** Column selection shared by every reader that projects {@link orderMoneyAmounts}. */
export function orderMoneySelection<
    T extends { [K in keyof OrderMoneyColumns]: unknown },
>(columns: T): Pick<T, keyof OrderMoneyColumns> {
    return {
        currencyDecimalPlaces: columns.currencyDecimalPlaces,
        totalAmountMinor: columns.totalAmountMinor,
        shippingAmountMinor: columns.shippingAmountMinor,
        discountAmountMinor: columns.discountAmountMinor,
        paidAmountMinor: columns.paidAmountMinor,
        balanceDueMinor: columns.balanceDueMinor,
    };
}
