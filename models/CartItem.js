import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const CartItem = sequelize.define(
  "CartItem",
  {
    cartId: { type: DataTypes.INTEGER, allowNull: false },
    productId: { type: DataTypes.INTEGER, allowNull: false },
    qty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  },
  {
    timestamps: true,
    indexes: [
      { unique: true, fields: ["cartId", "productId"] },
    ],
  }
);

export default CartItem;
