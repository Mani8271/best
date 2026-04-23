import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Cart = sequelize.define(
  "Cart",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  },
  { timestamps: true }
);

export default Cart;
