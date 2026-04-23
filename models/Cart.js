const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db.js");

const Cart = sequelize.define(
  "Cart",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  },
  { timestamps: true }
);

module.exports = Cart;
