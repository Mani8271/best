import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const BinaryNode = sequelize.define("BinaryNode", {
  userPkId: { type: DataTypes.STRING(12), allowNull: false, unique: true },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  parentId: { type: DataTypes.INTEGER, allowNull: true },
  position: { type: DataTypes.ENUM("LEFT", "RIGHT"), allowNull: true },
  leftChildId: { type: DataTypes.INTEGER, allowNull: true },
  rightChildId: { type: DataTypes.INTEGER, allowNull: true },
  leftQueue: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
  rightQueue: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
  userType: { type: DataTypes.STRING(40), allowNull: true },
  joiningDate: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },


}, {
  timestamps: true,
  indexes: [
    { fields: ["userId"] },
    { fields: ["parentId"] },
    { fields: ["leftChildId"] },
    { fields: ["rightChildId"] },
  ]
});

export default BinaryNode;
