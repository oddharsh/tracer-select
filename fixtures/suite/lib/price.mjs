export const total = (items) => items.reduce((sum, { price, qty }) => sum + price * qty, 0);
