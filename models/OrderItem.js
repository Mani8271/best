import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const OrderItem = sequelize.define(
  "OrderItem",
  {
    orderId: { type: DataTypes.INTEGER, allowNull: false },
    productId: { type: DataTypes.INTEGER, allowNull: false },

    // snapshot price at order time
    price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    qty: { type: DataTypes.INTEGER, allowNull: false },
  },
  { timestamps: true }
);

export default OrderItem;
