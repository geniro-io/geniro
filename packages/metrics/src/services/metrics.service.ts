import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  type HistogramConfiguration,
  Pushgateway,
  Registry,
} from 'prom-client';

import { type Labels } from '../metrics.types';

@Injectable()
export class MetricsService {
  private counterMetrics = new Map<string, Counter>();
  private gaugeMetrics = new Map<string, Gauge>();
  private histogramMetrics = new Map<string, Histogram>();
  private register = new Registry();

  public async getAll(): Promise<string> {
    return this.register.metrics();
  }

  public async clearAll(): Promise<void> {
    await this.register.clear();
  }

  public getGauge(index: string): Gauge | undefined {
    return this.gaugeMetrics.get(index);
  }

  public getCounter(index: string): Counter | undefined {
    return this.counterMetrics.get(index);
  }

  public getHistogram(index: string): Histogram | undefined {
    return this.histogramMetrics.get(index);
  }

  public registerGauge(index: string, description: string, labels: string[]) {
    if (!this.gaugeMetrics.has(index)) {
      const gauge = new Gauge({
        name: index,
        help: description,
        labelNames: labels,
      });

      this.gaugeMetrics.set(index, gauge);

      this.register.registerMetric(gauge);
    }
  }

  public registerCounter(index: string, description: string, labels: string[]) {
    if (!this.counterMetrics.has(index)) {
      const counter = new Counter({
        name: index,
        help: description,
        labelNames: labels,
      });

      this.counterMetrics.set(index, counter);

      this.register.registerMetric(counter);
    }
  }

  public incCounter(index: string, val: number, labels?: Labels) {
    const counter = this.counterMetrics.get(index);

    if (counter) {
      if (labels) {
        counter.inc(labels, val);
      } else {
        counter.inc(val);
      }
    }
  }

  public setGauge(index: string, val: number, labels?: Labels) {
    const gauge = this.gaugeMetrics.get(index);

    if (gauge) {
      if (labels) {
        gauge.set(labels, val);
      } else {
        gauge.set(val);
      }
    }
  }

  public registerHistogram(
    index: string,
    description: string,
    labels: string[],
    buckets?: number[],
  ) {
    if (!this.histogramMetrics.has(index)) {
      const conf: HistogramConfiguration<string> = {
        name: index,
        help: description,
        labelNames: labels,
      };

      if (buckets) {
        conf.buckets = buckets;
      }

      const histogram = new Histogram(conf);

      this.histogramMetrics.set(index, histogram);

      this.register.registerMetric(histogram);
    }
  }

  public incGauge(index: string, val: number, labels?: Labels) {
    const gauge = this.gaugeMetrics.get(index);

    if (gauge) {
      if (labels) {
        gauge.inc(labels, val);
      } else {
        gauge.inc(val);
      }
    }
  }

  public observeHistogram(index: string, val: number, labels?: Labels) {
    const histogram = this.histogramMetrics.get(index);

    if (histogram) {
      if (labels) {
        histogram.observe(labels, val);
      } else {
        histogram.observe(val);
      }
    }
  }

  public async pushMetrics(gatewayUrl: string, jobName: string): Promise<void> {
    const pushGateway = new Pushgateway(
      gatewayUrl,
      { timeout: 10000 },
      this.register,
    );
    await pushGateway.pushAdd({ jobName });
  }
}
