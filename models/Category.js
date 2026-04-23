const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db.js");

const Category = sequelize.define(
  "Category",
  {
    name: { type: DataTypes.STRING(120), allowNull: false, unique: true },
       image: { type: DataTypes.STRING(255), allowNull: true },
  sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { timestamps: true }
);

module.exports = Category;
