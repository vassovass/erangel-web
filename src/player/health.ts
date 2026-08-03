export class Health {
  hp = 100;
  max = 100;
  dead = false;
  onDamage: ((amount: number, fromDx: number, fromDz: number) => void) | null = null;
  onDeath: (() => void) | null = null;

  damage(amount: number, fromDx = 0, fromDz = 0): void {
    if (this.dead) return;
    this.hp = Math.max(0, this.hp - amount);
    this.onDamage?.(amount, fromDx, fromDz);
    if (this.hp <= 0) {
      this.dead = true;
      this.onDeath?.();
    }
  }

  heal(amount: number): void {
    if (this.dead) return;
    this.hp = Math.min(this.max, this.hp + amount);
  }

  reset(): void {
    this.hp = this.max;
    this.dead = false;
  }
}
